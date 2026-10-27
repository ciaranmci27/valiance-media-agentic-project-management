import type { SupabaseClient } from '@supabase/supabase-js';
import { insertTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import type { AccessContext } from '@/lib/access-control';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject } from '@/lib/api/task-guards';
import { assertCanManageParent, loadParentTask, nextSubtaskOrder, subtaskRuleError } from '@/lib/api/subtasks';

interface CreateTaskContext {
  supabase: SupabaseClient;
  body: unknown;
  apiKeyId: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
}

/** Who a task is created as: their client, member, access, and whether they may assign others. */
export interface TaskActor {
  supabase: SupabaseClient;
  memberId: string;
  access: AccessContext;
  canAssignOthers: boolean;
  /** Which of the member's permissions apply: their API ones (a key) or their app ones (a person in the app). */
  channel?: 'api' | 'app';
}

/**
 * A task created through the API key: on a project the key may open, assigned
 * to the key's member unless the key may assign others, with its criteria and
 * blockers. endpoint names the route in the audit log.
 */
export async function createApiTask({ supabase, body, apiKeyId, teamMemberId, access, scopes }: CreateTaskContext, endpoint: string) {
  const canAssignOthers = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
  const task = await createTaskAs({ supabase, memberId: teamMemberId, access, canAssignOthers }, body);
  logAudit(supabase, { method: 'POST', endpoint, entityType: 'task', entityId: task.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 201 });
  return task;
}

/**
 * A task created as a member with API access: on a project they may open,
 * assigned to them unless they may assign others, with its criteria and
 * blockers. The body is createTaskSchema's; with parent_task_id it is a
 * subtask of a task they may manage, in that task's project.
 */
export async function createTaskAs({ supabase, memberId: teamMemberId, access, canAssignOthers, channel = 'api' }: TaskActor, body: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by createTaskSchema by the caller
  const { assignee_ids, acceptance_criteria, blocked_by_ids, source_note, parent_task_id, ...taskData } = body as any;
  let sortOrder: number | undefined;
  if (parent_task_id) {
    const parent = await loadParentTask(supabase, parent_task_id, access, channel);
    if (taskData.project_id && taskData.project_id !== parent.project_id) {
      throw badRequest("A subtask is always in its parent task's project: leave out project_id, or send the parent's");
    }
    assertCanManageParent(parent, teamMemberId, canAssignOthers);
    taskData.project_id = parent.project_id;
    sortOrder = await nextSubtaskOrder(supabase, parent.id);
  }
  if (!taskData.project_id || !accessAllowsProject(access, taskData.project_id, channel)) {
    throw forbidden('Project scope denied');
  }
  const { data: liveProject } = await supabase
    .from('projects')
    .select('id')
    .eq('id', taskData.project_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!liveProject) throw notFound('Project');
  const requestedAssignees = Array.isArray(assignee_ids) ? assignee_ids : [];
  if (!canAssignOthers && requestedAssignees.some((id: string) => id !== teamMemberId)) {
    throw forbidden('This API key can only assign newly created tasks to its own member');
  }
  const effectiveAssignees = canAssignOthers ? requestedAssignees : [teamMemberId];
  await assertAssigneesCanOpenProject(supabase, effectiveAssignees.filter(Boolean), taskData.project_id);
  const blockedByIds: string[] = Array.isArray(blocked_by_ids) ? blocked_by_ids : [];
  if (blockedByIds.length > 0) {
    await assertBlockersInProject(supabase, blockedByIds, taskData.project_id);
  }
  if (taskData.project_goal_id) {
    await assertGoalInProject(supabase, taskData.project_goal_id, taskData.project_id);
  }
  const criteria: string[] = Array.isArray(acceptance_criteria) ? acceptance_criteria : [];
  try {
    return await insertTask(
      supabase,
      {
        ...taskData,
        ...(parent_task_id ? { parent_task_id, sort_order: sortOrder } : {}),
        created_by: teamMemberId || null,
        created_note: source_note ?? null,
      },
      effectiveAssignees,
      criteria,
      blockedByIds
    );
  } catch (error) {
    throw subtaskRuleError(error);
  }
}
