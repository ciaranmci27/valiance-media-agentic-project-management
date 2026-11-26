import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTaskSchema } from '@/lib/schemas';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { patchTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject } from '@/lib/api/task-guards';
import { loadParentTask, setTaskParentAs, subtaskRuleError } from '@/lib/api/subtasks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyClosePolicy, commentSentToReview, loadMemberRules, sentToReviewNote } from '@/lib/api/agent-rules';
import { readTaskInFull } from '@/lib/api/task-read';
import { finishTaskMove, lostAccessError, movingIds, planTaskMove, prepareTaskMove, resolveLostAccess, type LostAccessChoice } from '@/lib/api/task-move';
import { isModuleEnabled } from '@/lib/access-control';

async function currentAssigneeIds(supabase: SupabaseClient, taskId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('task_assignees')
    .select('member_id')
    .eq('task_id', taskId);
  if (error) throw error;
  return (data || []).map((row: { member_id: string }) => row.member_id);
}

export const GET = withApi(async ({ supabase, params, access }) => {
  return success(await readTaskInFull(supabase, params.id, { agentsOn: isModuleEnabled(access, 'agents') }));
}, { permission: 'tasks.read' });

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Task');
  const { assignee_ids, acceptance_criteria, blocked_by_ids, parent_task_id, lost_access, ...updates } = body as any;
  const canManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
  // An agent whose rules send finished work to review cannot set done: the
  // task goes to In Review instead, with a comment saying why.
  const member = updates.status === 'done' && access.role === 'agent' ? await loadMemberRules(supabase, teamMemberId) : null;
  const close = member ? applyClosePolicy(member, updates.status, before.status) : { status: updates.status, sentToReview: false };
  if (close.sentToReview) updates.status = close.status;
  const parentChange = parent_task_id !== undefined && parent_task_id !== before.parent_task_id;
  if (parentChange && updates.project_id !== undefined && updates.project_id !== before.project_id) {
    throw badRequest("Send parent_task_id or project_id, not both: a subtask takes its parent task's project");
  }
  if (!parentChange && before.parent_task_id && updates.project_id !== undefined && updates.project_id !== before.project_id) {
    throw badRequest("A subtask stays in its parent task's project. Move the parent, or make it top-level first (parent_task_id: null)");
  }
  if (assignee_ids !== undefined && !canManageAll) {
    throw forbidden('Changing task assignments requires the tasks.manage_all API scope');
  }
  // An agent whose rules keep it off unassigned work cannot assign itself
  // either: adding itself to a task it is not on is the same as picking it up.
  if (Array.isArray(assignee_ids) && assignee_ids.includes(teamMemberId) && access.role === 'agent'
    && !(await currentAssigneeIds(supabase, id)).includes(teamMemberId)) {
    const self = await loadMemberRules(supabase, teamMemberId);
    if (self.isAgent && !self.rules.agent_self_assign) {
      throw forbidden(`${self.name}'s rules do not let it assign itself work. Ask for the task to be assigned to it.`, {
        reason: 'self_assign_off',
        hint: 'An Owner or admin can turn on "Can pick up unassigned work" in the agent\'s rules (Team page, or set_agent_rules).',
      });
    }
  }
  const blockedByIds: string[] | undefined = Array.isArray(blocked_by_ids) ? blocked_by_ids : undefined;

  // The middleware only authorized the task's current project. Moving it
  // (directly, or under a parent in another project) must also be allowed on
  // the destination, and whatever the task keeps has to live there too.
  let targetProjectId: string = updates.project_id ?? before.project_id;
  if (parentChange && parent_task_id) {
    const parent = await loadParentTask(supabase, parent_task_id, access);
    targetProjectId = parent.project_id;
  }
  const isMove = targetProjectId !== before.project_id;
  const mover = { db: supabase, access, memberId: teamMemberId, channel: 'api' as const, scopes };
  const moved = { removed: [] as string[], added: [] as string[] };
  let moveSubtasks: string[] = [];
  if (isMove && !parentChange) {
    // A direct move: one set of rules with the app and MCP (task-move.ts).
    const plan = await planTaskMove(mover, id, targetProjectId, {
      assigneeIds: Array.isArray(assignee_ids) ? assignee_ids : undefined,
      blockedByIds,
      goalId: updates.project_goal_id ?? undefined,
    });
    // Assignees the request names itself are checked as before; the people
    // already on it are settled as lost_access says, or refuse the move.
    if (Array.isArray(assignee_ids) && assignee_ids.length > 0) {
      await assertAssigneesCanOpenProject(supabase, assignee_ids, targetProjectId);
    }
    const lostAccess = (lost_access as LostAccessChoice | undefined) ?? 'refuse';
    if (lostAccess === 'refuse' && plan.losing.length) throw lostAccessError(mover, plan);
    // Its files are copied to the new project first: a Storage failure leaves the task where it was.
    moveSubtasks = movingIds(plan).slice(1);
    await prepareTaskMove(mover, movingIds(plan), targetProjectId);
    Object.assign(moved, await resolveLostAccess(mover, plan, lostAccess));
    // The goal is the old project's: cleared unless the request names one there.
    if (updates.project_goal_id === undefined) updates.project_goal_id = null;
  } else if (isMove) {
    if (!canManageAll) {
      throw forbidden('Moving a task to another project requires the tasks.manage_all API scope');
    }
    if (!accessAllowsProject(access, targetProjectId, 'api')) {
      throw forbidden('Project scope denied', {
        reason: 'project_scope',
        grant_on: 'project_membership',
        project_id: targetProjectId,
        hint: 'Assign the linked member to the destination project, or grant projects.read_all.',
      });
    }
    // A task cannot move into a project in Trash.
    const { data: liveTarget } = await supabase
      .from('projects')
      .select('id')
      .eq('id', targetProjectId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!liveTarget) throw notFound('Project');
  }

  // Nesting under another project's task keeps no blocker links (the database
  // refuses, saying why) and takes the parent's goal.
  const effectiveBlockerIds = blockedByIds ?? [];
  if (effectiveBlockerIds.length > 0) {
    await assertBlockersInProject(supabase, effectiveBlockerIds, targetProjectId, id);
  }
  const goalId: string | null | undefined = updates.project_goal_id !== undefined ? updates.project_goal_id : null;
  if (goalId) {
    await assertGoalInProject(supabase, goalId, targetProjectId);
  }
  // New assignees, and when nesting under another project's task everyone
  // who stays assigned, must be able to open the task where it will live.
  const effectiveAssignees: string[] = Array.isArray(assignee_ids)
    ? assignee_ids
    : (isMove && parentChange ? await currentAssigneeIds(supabase, id) : []);
  if (effectiveAssignees.length > 0) {
    await assertAssigneesCanOpenProject(supabase, effectiveAssignees, targetProjectId);
  }
  const criteria: string[] | undefined = Array.isArray(acceptance_criteria) ? acceptance_criteria : undefined;
  // Nesting or promoting goes first, through the database's subtask rules;
  // the rest of the change lands on the task where it now lives.
  let data: Record<string, unknown> = before;
  // Nested under another project's task, it moves there: its files are copied first.
  if (isMove && parentChange) await prepareTaskMove(mover, [id], targetProjectId);
  if (parentChange) {
    data = await setTaskParentAs({ supabase, memberId: teamMemberId, access, canManageAll }, before, parent_task_id);
  }
  const hasOtherChanges = Object.keys(updates).length > 0 || assignee_ids !== undefined || criteria !== undefined || blockedByIds !== undefined;
  if (hasOtherChanges) {
    try {
      data = await patchTask(supabase, id, updates, assignee_ids, criteria, blockedByIds);
    } catch (error) {
      throw subtaskRuleError(error);
    }
  }
  if (isMove) {
    // Its uploads, the conversations it came from and the agent's plan items follow it.
    await finishTaskMove(mover, [id, ...moveSubtasks], targetProjectId);
    if (moved.removed.length || moved.added.length) data = { ...data, removed: moved.removed, added_to_project: moved.added };
  }
  if (close.sentToReview && member) {
    await commentSentToReview(supabase, id, member);
    data = { ...data, sent_to_review: true, note: sentToReviewNote(member) };
  }
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateTaskSchema, permission: 'tasks.manage_assigned' });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Task');

  await trashForApi(supabase, 'tasks', id, teamMemberId, 'Task');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
}, { permission: 'tasks.manage_all' });
