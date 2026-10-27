import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTaskSchema } from '@/lib/schemas';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { patchTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject, liveTaskIds } from '@/lib/api/task-guards';
import { loadParentTask, setTaskParentAs, subtaskRuleError, subtaskSummaries } from '@/lib/api/subtasks';
import type { SupabaseClient } from '@supabase/supabase-js';

async function currentAssigneeIds(supabase: SupabaseClient, taskId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('task_assignees')
    .select('member_id')
    .eq('task_id', taskId);
  if (error) throw error;
  return (data || []).map((row: { member_id: string }) => row.member_id);
}

async function currentBlockerIds(supabase: SupabaseClient, taskId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('task_dependencies')
    .select('blocked_by_task_id')
    .eq('task_id', taskId);
  if (error) throw error;
  // A blocker in Trash blocks nothing, so a move does not carry it along.
  const ids = (data || []).map((row: { blocked_by_task_id: string }) => row.blocked_by_task_id);
  const live = await liveTaskIds(supabase, ids);
  return ids.filter((blockerId) => live.has(blockerId));
}

// A parent moving to another project takes its subtasks (the database moves
// them), so they must be able to live there too: no blocker links, which stay
// inside one project, and assignees who can open it.
async function assertSubtasksCanMove(supabase: SupabaseClient, taskId: string, targetProjectId: string) {
  const { data: children, error } = await supabase
    .from('tasks')
    .select('id, task_assignees(member_id)')
    .eq('parent_task_id', taskId)
    .is('deleted_at', null);
  if (error) throw error;
  const childIds = (children || []).map((child: { id: string }) => child.id);
  if (childIds.length === 0) return;
  const list = `(${childIds.join(',')})`;
  const { data: links, error: linkError } = await supabase
    .from('task_dependencies')
    .select('task_id')
    .or(`task_id.in.${list},blocked_by_task_id.in.${list}`)
    .limit(1);
  if (linkError) throw linkError;
  if ((links || []).length > 0) {
    throw badRequest('Its subtasks are blocked by, or block, tasks in this project. Remove those links before moving it to another project');
  }
  const assignees = (children || []).flatMap((child: { task_assignees: { member_id: string }[] | null }) =>
    (child.task_assignees || []).map((a) => a.member_id));
  if (assignees.length > 0) await assertAssigneesCanOpenProject(supabase, assignees, targetProjectId);
}

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      *,
      task_assignees(member_id),
      comments:task_comments(id, task_id, user_id, text, created_at),
      criteria:task_acceptance_criteria(id, task_id, criterion, satisfied, sort_order),
      reviews:task_reviews(id, round, verdict, summary, pr_url, head_sha, reviewer_member_id, created_at),
      task_dependencies!task_dependencies_task_id_fkey(
        blocker:tasks!task_dependencies_blocked_by_task_id_fkey(id, title, status, deleted_at)
      )
    `)
    .eq('id', (params as any).id)
    .is('deleted_at', null)
    .is('comments.deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Task');

  // A subtask names its parent; a parent lists its subtasks.
  let parent: { id: string; title: string; status: string } | null = null;
  if (data.parent_task_id) {
    const { data: parentRow, error: parentError } = await supabase
      .from('tasks')
      .select('id, title, status')
      .eq('id', data.parent_task_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (parentError) throw parentError;
    parent = parentRow;
  }
  const subtasks = (await subtaskSummaries(supabase, [data.id])).get(data.id) ?? [];

  // A blocker in Trash blocks nothing, as deleting it used to remove the
  // dependency. (The same project, so it cannot be in a trashed project.)
  type Blocker = { id: string; title: string; status: string; deleted_at: string | null };
  const rawDependencies = ((data.task_dependencies || []) as { blocker: Blocker | null }[])
    .filter((d) => !d.blocker?.deleted_at);
  const blockedBy = rawDependencies
    .map((d) => d.blocker)
    .filter((blocker): blocker is Blocker => !!blocker)
    .map((blocker) => ({ id: blocker.id, title: blocker.title, status: blocker.status }));
  // A blocker the caller cannot resolve is still a blocker. filter(Boolean)
  // drops rows whose joined task is hidden by project scoping or RLS, and
  // .every() on what survives then reports dependencies_met: true. The agent
  // reads that as cleared and starts work that is genuinely blocked.
  //
  // Same failure shape as blanking a project's operating parameters, in the
  // other direction: a read path returning a plausible value instead of
  // refusing. Unresolved rows now fail closed.
  const unresolvedBlockers = rawDependencies.length - blockedBy.length;

  const task = {
    ...data,
    assignee_ids: (data.task_assignees || []).map((ta: any) => ta.member_id),
    parent,
    subtasks,
    comments: (data.comments || []).sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    acceptance_criteria: (data.criteria || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    // Newest review row is the task's current verdict; jeff-automerge reads
    // this field and fails closed when it is null. Round breaks created_at
    // ties (same-millisecond rows would otherwise be nondeterministic).
    latest_review: (data.reviews || []).slice().sort((a: any, b: any) =>
      (new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      || ((b.round ?? 0) - (a.round ?? 0))
    )[0] ?? null,
    blocked_by: blockedBy,
    blocked_by_ids: blockedBy.map((b: any) => b.id),
    dependencies_met: unresolvedBlockers === 0 && blockedBy.every((b: any) => b.status === 'done'),
    criteria: undefined,
    reviews: undefined,
    task_dependencies: undefined,
    task_assignees: undefined,
  };

  return success(task);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Task');
  const { assignee_ids, acceptance_criteria, blocked_by_ids, parent_task_id, ...updates } = body as any;
  const canManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
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
  if (isMove) {
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
    await assertSubtasksCanMove(supabase, id, targetProjectId);
  }

  // Nesting under another project's task keeps no blocker links (the database
  // refuses, saying why) and takes the parent's goal.
  const carries = isMove && !parentChange;
  const effectiveBlockerIds = blockedByIds ?? (carries ? await currentBlockerIds(supabase, id) : []);
  if (effectiveBlockerIds.length > 0) {
    await assertBlockersInProject(supabase, effectiveBlockerIds, targetProjectId, id);
  }
  const goalId: string | null | undefined = updates.project_goal_id !== undefined
    ? updates.project_goal_id
    : (carries ? before.project_goal_id : null);
  if (goalId) {
    await assertGoalInProject(supabase, goalId, targetProjectId);
  }
  // New assignees, and on a move everyone who stays assigned, must be able
  // to open the task where it will live.
  const effectiveAssignees: string[] = Array.isArray(assignee_ids)
    ? assignee_ids
    : (isMove ? await currentAssigneeIds(supabase, id) : []);
  if (effectiveAssignees.length > 0) {
    await assertAssigneesCanOpenProject(supabase, effectiveAssignees, targetProjectId);
  }
  const criteria: string[] | undefined = Array.isArray(acceptance_criteria) ? acceptance_criteria : undefined;
  // Nesting or promoting goes first, through the database's subtask rules;
  // the rest of the change lands on the task where it now lives.
  let data: Record<string, unknown> = before;
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
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateTaskSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Task');

  await trashForApi(supabase, 'tasks', id, teamMemberId, 'Task');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
