import type { SupabaseClient } from '@supabase/supabase-js';
import { insertTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import type { AccessContext } from '@/lib/access-control';
import { forbidden, notFound } from '@/lib/api/errors';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject } from '@/lib/api/task-guards';

interface CreateTaskContext {
  supabase: SupabaseClient;
  body: unknown;
  apiKeyId: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
}

/**
 * A task created through the API key: on a project the key may open, assigned
 * to the key's member unless the key may assign others, with its criteria and
 * blockers. endpoint names the route in the audit log.
 */
export async function createApiTask({ supabase, body, apiKeyId, teamMemberId, access, scopes }: CreateTaskContext, endpoint: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by createTaskSchema at the route
  const { assignee_ids, acceptance_criteria, blocked_by_ids, source_note, ...taskData } = body as any;
  if (!taskData.project_id || !accessAllowsProject(access, taskData.project_id, 'api')) {
    throw forbidden('Project scope denied');
  }
  const { data: liveProject } = await supabase
    .from('projects')
    .select('id')
    .eq('id', taskData.project_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!liveProject) throw notFound('Project');
  const canAssignOthers = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
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
  const task = await insertTask(
    supabase,
    { ...taskData, created_by: teamMemberId || null, created_note: source_note ?? null },
    effectiveAssignees,
    criteria,
    blockedByIds
  );
  logAudit(supabase, { method: 'POST', endpoint, entityType: 'task', entityId: task.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 201 });
  return task;
}
