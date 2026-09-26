import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest } from '@/lib/api/errors';
import { accessAllowsProject, resolveMemberAccess } from '@/lib/api/access';

// Every task in the list must exist inside the given project. Used for time
// entry task links, where cross-project references would corrupt billing
// traceability.
export async function assertTasksInProject(
  supabase: SupabaseClient,
  taskIds: string[],
  projectId: string,
) {
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return;
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, project_id')
    .in('id', uniqueIds);
  if (error) throw error;
  const found = new Map((tasks || []).map((t: { id: string; project_id: string }) => [t.id, t.project_id]));
  for (const id of uniqueIds) {
    if (found.get(id) !== projectId) {
      throw badRequest('task_ids must reference existing tasks in this project');
    }
  }
}

// Everyone assigned must be able to open the task's project (on either
// channel: agents often hold project access on the API channel only).
// Assigning never grants access, so an assignee outside the project would be
// handed work they cannot see.
export async function assertAssigneesCanOpenProject(
  supabase: SupabaseClient,
  memberIds: string[],
  projectId: string,
) {
  for (const memberId of [...new Set(memberIds)]) {
    const access = await resolveMemberAccess(supabase, memberId);
    const canOpen = !!access
      && (accessAllowsProject(access, projectId, 'app') || accessAllowsProject(access, projectId, 'api'));
    if (!canOpen) {
      throw badRequest('assignee_ids must reference members who can open this project');
    }
  }
}

// A task's goal must be one of its own project's goals, or a scoped key could
// hang work off (and read progress into) a project it cannot see.
export async function assertGoalInProject(
  supabase: SupabaseClient,
  goalId: string,
  projectId: string,
) {
  const { data: goal, error } = await supabase
    .from('project_goals')
    .select('id, project_id')
    .eq('id', goalId)
    .maybeSingle();
  if (error) throw error;
  if (!goal || goal.project_id !== projectId) {
    throw badRequest('project_goal_id must reference a goal in the same project');
  }
}

// Blockers must belong to the same project as the task; anything else is
// rejected so cross-project task titles can never leak through dependencies.
export async function assertBlockersInProject(
  supabase: SupabaseClient,
  blockedByIds: string[],
  projectId: string,
  taskId?: string
) {
  const uniqueIds = [...new Set(blockedByIds)];
  if (taskId && uniqueIds.includes(taskId)) {
    throw badRequest('A task cannot be blocked by itself');
  }
  const { data: blockers, error } = await supabase
    .from('tasks')
    .select('id, project_id')
    .in('id', uniqueIds);
  if (error) throw error;
  const found = new Map((blockers || []).map((b: { id: string; project_id: string }) => [b.id, b.project_id]));
  for (const id of uniqueIds) {
    if (found.get(id) !== projectId) {
      throw badRequest('blocked_by_ids must reference existing tasks in the same project');
    }
  }
}
