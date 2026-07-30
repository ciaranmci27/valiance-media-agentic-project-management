import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest } from '@/lib/api/errors';

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
