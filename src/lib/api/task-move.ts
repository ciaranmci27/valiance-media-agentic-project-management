import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { accessAllows, accessAllowsProject, apiKeyAllows, resolveMemberAccess } from '@/lib/api/access';
import { ApiError, badRequest, forbidden, notFound } from '@/lib/api/errors';
import { releaseClaimAs } from '@/lib/api/claims';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject, liveTaskIds } from '@/lib/api/task-guards';
import { comms } from '@/lib/communications/db';
import { patchTask } from '@/lib/supabase/queries';
import { carryTaskFilesToProject, copyTaskFilesToProject } from '@/lib/task-files/service';

/**
 * Moving a task to another project: one set of rules for the app (the task
 * menu, the panel, bulk, the agent's receipt in the Inbox), the API
 * (PATCH /api/v1/tasks/{id} with project_id) and MCP (update_task, which
 * calls that route).
 *
 * Who may: someone who can edit the task where it is (every task with
 * manage_all, their own with manage_assigned) and create tasks where it goes.
 *
 * What moves with it: its subtasks (the database moves them with the parent),
 * reminders, questions and agent runs (database triggers), comments, activity,
 * links and claims (keyed by the task). What has to change here: its uploads
 * are stored per project, so each is copied to the new project's folder; a
 * linked project file belongs to the old project, so it stays on the task as
 * a link to the same file; the goal is the old project's, so it is cleared;
 * the conversations it came from are filed on the new project too; and the
 * agent's plan items that made or touched it name the new project.
 *
 * Nobody is ever given access silently. Anyone assigned to the task or its
 * subtasks, or holding a claim on one, who cannot open the new project is
 * listed; the move goes ahead only once they are taken off ('unassign') or
 * added to the project ('add_to_project', for someone who may manage its
 * members).
 */

export type LostAccessChoice = 'refuse' | 'unassign' | 'add_to_project';

export interface TaskMoveActor {
  /** The service role naming the member (getActorClient), so the activity log says who moved it. */
  db: SupabaseClient;
  access: AccessContext;
  memberId: string;
  channel: 'app' | 'api';
  /** API only: the key's scopes. A permission must be on both the key and the member. */
  scopes?: string[];
}

export interface LosingMember {
  id: string;
  name: string;
  /** Why they are on it: assigned to the task or a subtask, or holding a claim. */
  on: ('assigned' | 'claimed')[];
  /** Adding them to the project would let them open it (they may read the projects they belong to). */
  can_be_added: boolean;
}

export interface TaskMovePlan {
  task: { id: string; title: string; project_id: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  subtask_ids: string[];
  /** Its subtasks in Trash: the database moves them with it too, so a restore finds them there. */
  trashed_subtask_ids: string[];
  /** Everyone who would lose the task, and why. */
  losing: LosingMember[];
  /** The mover may take people off tasks (manage every task). */
  can_unassign: boolean;
  /** The mover may add people to the new project. */
  can_add_members: boolean;
}

export interface TaskMoveResult {
  task: Record<string, unknown>;
  from: { id: string; name: string };
  to: { id: string; name: string };
  subtasks_moved: number;
  files_moved: number;
  conversations_filed: number;
  removed: string[];
  added_to_project: string[];
}

type TaskRow = {
  id: string;
  title: string;
  project_id: string;
  parent_task_id: string | null;
  claimed_by: string | null;
  task_assignees: { member_id: string }[] | null;
};

function can(actor: TaskMoveActor, permission: Parameters<typeof accessAllows>[1]): boolean {
  return actor.channel === 'api'
    ? apiKeyAllows(actor.access, actor.scopes ?? [], permission)
    : accessAllows(actor.access, permission, 'app');
}

async function loadTask(db: SupabaseClient, taskId: string): Promise<TaskRow | null> {
  const { data, error } = await db.from('tasks')
    .select('id, title, project_id, parent_task_id, claimed_by, task_assignees(member_id), project:projects!inner(id)')
    .eq('id', taskId).is('deleted_at', null).is('project.deleted_at', null).maybeSingle();
  if (error) throw error;
  return (data as unknown as TaskRow | null) ?? null;
}

async function projectName(db: SupabaseClient, projectId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return (data as { id: string; name: string } | null) ?? null;
}

/** Whether a member can open the project on either channel (agents often reach projects through the API only). */
async function canOpen(db: SupabaseClient, memberId: string, projectId: string): Promise<{ open: boolean; addable: boolean }> {
  const access = await resolveMemberAccess(db, memberId);
  if (!access || access.status !== 'active') return { open: false, addable: false };
  const open = accessAllowsProject(access, projectId, 'app') || accessAllowsProject(access, projectId, 'api');
  const addable = accessAllows(access, 'projects.read', 'app') || accessAllows(access, 'projects.read', 'api');
  return { open, addable };
}

/**
 * Checks a move and works out who would lose the task. Throws what refuses
 * it outright (no right to edit or create, a project out of reach or in
 * Trash, a subtask, blocker links). `assigneeIds` and `blockedByIds` are the
 * lists a PATCH replaces at the same time, when it does; `goalId` a goal it
 * sets in the new project.
 */
export async function planTaskMove(
  actor: TaskMoveActor,
  taskId: string,
  targetProjectId: string,
  overrides: { assigneeIds?: string[]; blockedByIds?: string[]; goalId?: string | null } = {},
): Promise<TaskMovePlan> {
  const { db, access, memberId, channel } = actor;
  const api = channel === 'api';
  const task = await loadTask(db, taskId);
  if (!task || !accessAllowsProject(access, task.project_id, channel)) {
    throw new ApiError(404, 'NOT_FOUND', api ? 'Task not found. It may be in Trash.' : 'That task is not there, or you cannot open it');
  }
  const assignees = (task.task_assignees ?? []).map((row) => row.member_id);
  let mayEdit = can(actor, 'tasks.manage_all');
  if (!mayEdit && can(actor, 'tasks.manage_assigned')) {
    mayEdit = assignees.includes(memberId);
    if (!mayEdit && task.parent_task_id) {
      const { data: onParent } = await db.from('task_assignees').select('member_id').eq('task_id', task.parent_task_id).eq('member_id', memberId).maybeSingle();
      mayEdit = !!onParent;
    }
  }
  if (!mayEdit) throw forbidden(api ? 'This API key can only modify assigned tasks' : 'You cannot change this task', { reason: 'cannot_edit_task' });
  if (task.parent_task_id) {
    throw badRequest(api
      ? "A subtask stays in its parent task's project. Move the parent, or make it top-level first (parent_task_id: null)"
      : "A subtask stays in its parent task's project. Move the parent task instead.");
  }
  if (targetProjectId === task.project_id) throw badRequest('The task is already in that project');
  if (!can(actor, 'tasks.create')) {
    throw forbidden('Moving a task to another project takes the right to create tasks there', {
      reason: 'missing_create_permission',
      hint: api ? "Grant 'tasks.create' to both the API key scopes and the linked member." : undefined,
    });
  }
  if (!accessAllowsProject(access, targetProjectId, channel)) {
    throw forbidden('Project scope denied', {
      reason: 'project_scope',
      grant_on: 'project_membership',
      project_id: targetProjectId,
      hint: 'Assign the linked member to the destination project, or grant projects.read_all.',
    });
  }
  const [from, to] = await Promise.all([projectName(db, task.project_id), projectName(db, targetProjectId)]);
  if (!to) throw notFound('Project');

  // Its subtasks go with it, so their links and people must be able to live
  // there too. Those in Trash move as well (the database moves every child),
  // so their people count and their files follow.
  // includes-deleted: subtasks in Trash move with their parent.
  const { data: childRows, error: childError } = await db.from('tasks')
    .select('id, claimed_by, deleted_at, task_assignees(member_id)').eq('parent_task_id', task.id);
  if (childError) throw childError;
  const children = (childRows ?? []) as unknown as { id: string; claimed_by: string | null; deleted_at: string | null; task_assignees: { member_id: string }[] | null }[];
  const childIds = children.filter((child) => !child.deleted_at).map((child) => child.id);
  const trashedChildIds = children.filter((child) => !!child.deleted_at).map((child) => child.id);

  // Blocker links stay inside one project, so no task title leaks across: the
  // task's own blockers (or the ones the PATCH sets), and every link a subtask
  // or the task holds with a task that stays behind.
  const blockers = overrides.blockedByIds ?? await liveBlockers(db, task.id);
  if (blockers.length > 0) {
    if (overrides.blockedByIds) await assertBlockersInProject(db, blockers, targetProjectId, task.id);
    else throw badRequest(api ? 'blocked_by_ids must reference existing tasks in the same project' : 'It is blocked by tasks in this project. Remove those links before moving it.');
  }
  const moving = [task.id, ...childIds];
  const list = `(${moving.join(',')})`;
  const { data: links, error: linkError } = await db.from('task_dependencies')
    .select('task_id, blocked_by_task_id').or(`task_id.in.${list},blocked_by_task_id.in.${list}`);
  if (linkError) throw linkError;
  const crossing = ((links ?? []) as { task_id: string; blocked_by_task_id: string }[])
    .filter((link) => !(link.task_id === task.id && overrides.blockedByIds) && (!moving.includes(link.task_id) || !moving.includes(link.blocked_by_task_id)));
  const liveCrossing = await liveTaskIds(db, crossing.flatMap((link) => [link.task_id, link.blocked_by_task_id]).filter((id) => !moving.includes(id)));
  if (crossing.some((link) => liveCrossing.has(moving.includes(link.task_id) ? link.blocked_by_task_id : link.task_id))) {
    throw badRequest(childIds.length
      ? 'Its subtasks are blocked by, or block, tasks in this project. Remove those links before moving it to another project'
      : 'It blocks other tasks in this project. Remove those links before moving it to another project');
  }
  if (overrides.goalId) await assertGoalInProject(db, overrides.goalId, targetProjectId);

  // Who would lose it: everyone assigned to it or a subtask, and anyone holding a claim.
  const roles = new Map<string, Set<'assigned' | 'claimed'>>();
  const add = (id: string | null, why: 'assigned' | 'claimed') => {
    if (!id) return;
    if (!roles.has(id)) roles.set(id, new Set());
    roles.get(id)!.add(why);
  };
  for (const id of overrides.assigneeIds ?? assignees) add(id, 'assigned');
  add(task.claimed_by, 'claimed');
  for (const child of children) {
    for (const row of child.task_assignees ?? []) add(row.member_id, 'assigned');
    add(child.claimed_by, 'claimed');
  }
  const ids = [...roles.keys()];
  const checks = await Promise.all(ids.map(async (id) => ({ id, ...(await canOpen(db, id, targetProjectId)) })));
  const outside = checks.filter((check) => !check.open);
  const { data: names, error: nameError } = outside.length
    ? await db.from('team_members').select('id, name').in('id', outside.map((check) => check.id))
    : { data: [], error: null };
  if (nameError) throw nameError;
  const nameOf = new Map(((names ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  return {
    task: { id: task.id, title: task.title, project_id: task.project_id },
    from: from ?? { id: task.project_id, name: 'Another project' },
    to,
    subtask_ids: childIds,
    trashed_subtask_ids: trashedChildIds,
    losing: outside.map((check) => ({
      id: check.id,
      name: nameOf.get(check.id) ?? 'Someone',
      on: [...roles.get(check.id)!].sort(),
      can_be_added: check.addable,
    })),
    can_unassign: can(actor, 'tasks.manage_all'),
    can_add_members: can(actor, 'project_members.manage'),
  };
}

async function liveBlockers(db: SupabaseClient, taskId: string): Promise<string[]> {
  const { data, error } = await db.from('task_dependencies').select('blocked_by_task_id').eq('task_id', taskId);
  if (error) throw error;
  const ids = ((data ?? []) as { blocked_by_task_id: string }[]).map((row) => row.blocked_by_task_id);
  const live = await liveTaskIds(db, ids);
  return ids.filter((id) => live.has(id));
}

/** The refusal when people would lose the task and the caller chose nothing. */
export function lostAccessError(actor: TaskMoveActor, plan: TaskMovePlan): ApiError {
  const details = {
    reason: 'people_lose_access',
    project_id: plan.to.id,
    members: plan.losing,
    can_unassign: plan.can_unassign,
    can_add_members: plan.can_add_members,
    hint: 'Send lost_access: "unassign" to take them off, or "add_to_project" to add them to the project.',
  };
  if (actor.channel === 'api') return badRequest('assignee_ids must reference members who can open this project', details);
  const who = plan.losing.length === 1 ? `${plan.losing[0].name} cannot` : `${plan.losing.length} people on it cannot`;
  return new ApiError(409, 'PEOPLE_LOSE_ACCESS', `${who} open ${plan.to.name}`, details);
}

/**
 * Settles who would lose the task, before it moves: refuses ('refuse'),
 * takes them off the task, its subtasks and their claims ('unassign'), or
 * adds them to the new project ('add_to_project').
 */
export async function resolveLostAccess(actor: TaskMoveActor, plan: TaskMovePlan, choice: LostAccessChoice): Promise<{ removed: string[]; added: string[] }> {
  if (plan.losing.length === 0) return { removed: [], added: [] };
  const { db } = actor;
  if (choice === 'refuse') throw lostAccessError(actor, plan);
  if (choice === 'unassign') {
    if (!plan.can_unassign) throw forbidden('Taking people off a task takes the right to manage every task', { reason: 'cannot_unassign' });
    const ids = plan.losing.map((member) => member.id);
    const tasks = movingIds(plan);
    // includes-deleted: a claim on a subtask in Trash ends too, so a restore does not bring it back.
    const { data: claimed, error: claimError } = await db.from('tasks').select('id, deleted_at').in('id', tasks).in('claimed_by', ids);
    if (claimError) throw claimError;
    for (const row of (claimed ?? []) as { id: string; deleted_at: string | null }[]) {
      if (!row.deleted_at) await releaseClaimAs(db, actor.memberId, row.id, true);
      else {
        // includes-deleted: the claim release reads live tasks only.
        const { error: clearError } = await db.from('tasks')
          .update({ claimed_by: null, claimed_at: null, claim_expires_at: null, claim_assigned: false }).eq('id', row.id);
        if (clearError) throw clearError;
      }
    }
    const { error } = await db.from('task_assignees').delete().in('task_id', tasks).in('member_id', ids);
    if (error) throw error;
    return { removed: ids, added: [] };
  }
  if (!plan.can_add_members) throw forbidden("Adding people to a project takes the right to manage its members", { reason: 'cannot_add_members' });
  const blocked = plan.losing.filter((member) => !member.can_be_added);
  if (blocked.length) {
    throw badRequest(`${blocked.map((member) => member.name).join(', ')} cannot open projects even as a member. Take them off instead.`, { reason: 'cannot_be_added', members: blocked });
  }
  const { error } = await db.from('project_members')
    .upsert(plan.losing.map((member) => ({ project_id: plan.to.id, member_id: member.id })), { onConflict: 'project_id,member_id' });
  if (error) throw error;
  await assertAssigneesCanOpenProject(db, plan.losing.map((member) => member.id), plan.to.id);
  return { removed: [], added: plan.losing.map((member) => member.id) };
}

/** Every task a move takes: the task, its subtasks, and its subtasks in Trash. */
export function movingIds(plan: Pick<TaskMovePlan, 'task' | 'subtask_ids' | 'trashed_subtask_ids'>): string[] {
  return [plan.task.id, ...plan.subtask_ids, ...plan.trashed_subtask_ids];
}

/**
 * What must be in place before a task moves: its uploads copied to the new
 * project's folder. A Storage failure refuses the move, with nothing changed.
 */
export async function prepareTaskMove(actor: TaskMoveActor, taskIds: string[], projectId: string): Promise<void> {
  await copyTaskFilesToProject(actor.db, taskIds, projectId);
}

/**
 * What a move changes beyond the task row, once it has moved: uploads copied
 * to the new project's folder, a linked project file kept as a link, the
 * conversations it came from filed on the new project, and the agent's plan
 * items naming it. Safe to run twice.
 */
export async function finishTaskMove(actor: TaskMoveActor, taskIds: string[], projectId: string): Promise<{ files: number; conversations: number }> {
  const { db } = actor;
  const files = await carryTaskFilesToProject(db, taskIds, projectId);
  const { error: itemError } = await comms(db).from('plan_items').update({ project_id: projectId }).in('task_id', taskIds).neq('project_id', projectId);
  if (itemError) throw itemError;
  const { data: links, error: linkError } = await comms(db).from('task_links').select('message_id').in('task_id', taskIds);
  if (linkError) throw linkError;
  const messageIds = [...new Set(((links ?? []) as { message_id: string }[]).map((row) => row.message_id))];
  let conversations = 0;
  if (messageIds.length) {
    const { data: messages, error: messageError } = await comms(db).from('messages').select('id, thread_id').in('id', messageIds).neq('status', 'receiving');
    if (messageError) throw messageError;
    const firstOfThread = new Map<string, string>();
    for (const message of (messages ?? []) as { id: string; thread_id: string }[]) if (!firstOfThread.has(message.thread_id)) firstOfThread.set(message.thread_id, message.id);
    for (const messageId of firstOfThread.values()) {
      const { error } = await comms(db).rpc('file_message_project', { p_message_id: messageId, p_project_id: projectId, p_member_id: actor.memberId, p_as_person: true });
      if (error) console.error('[tasks] move: filing a conversation on the new project failed:', error);
      else conversations++;
    }
  }
  return { files, conversations };
}

/** Moves one task (with its subtasks) to another project, as the app and the conversation move do. */
export async function moveTask(actor: TaskMoveActor, taskId: string, targetProjectId: string, lostAccess: LostAccessChoice = 'refuse'): Promise<TaskMoveResult> {
  const plan = await planTaskMove(actor, taskId, targetProjectId);
  // Nobody is taken off or added for a move that is then refused.
  if (lostAccess === 'refuse' && plan.losing.length) throw lostAccessError(actor, plan);
  await prepareTaskMove(actor, movingIds(plan), targetProjectId);
  const { removed, added } = await resolveLostAccess(actor, plan, lostAccess);
  const task = await patchTask(actor.db, plan.task.id, { project_id: targetProjectId, project_goal_id: null });
  const { files, conversations } = await finishTaskMove(actor, movingIds(plan), targetProjectId);
  return {
    task: task as unknown as Record<string, unknown>,
    from: plan.from,
    to: plan.to,
    subtasks_moved: plan.subtask_ids.length,
    files_moved: files,
    conversations_filed: conversations,
    removed,
    added_to_project: added,
  };
}
