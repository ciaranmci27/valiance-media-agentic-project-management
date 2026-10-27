import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { reorderSubtasksSchema } from '@/lib/schemas';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

// Puts a task's subtasks in the order given (each one's sort_order is its place).
export const PUT = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id: taskId } = params as { id: string };
  const { subtask_ids } = body as { subtask_ids: string[] };

  const { data: existing } = await supabase
    .from('tasks')
    .select('id')
    .eq('parent_task_id', taskId)
    .in('id', subtask_ids)
    .is('deleted_at', null);

  if (!existing || existing.length !== new Set(subtask_ids).size) {
    throw badRequest('One or more subtask IDs do not belong to this task');
  }

  const results = await Promise.all(subtask_ids.map((subtaskId, index) =>
    supabase.from('tasks').update({ sort_order: index }).eq('id', subtaskId).eq('parent_task_id', taskId).is('deleted_at', null)));
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/tasks/${taskId}/subtasks/reorder`, entityType: 'task', entityId: taskId, apiKeyId, teamMemberId, requestBody: body, statusCode: 200 });
  return success({ reordered: true });
}, { schema: reorderSubtasksSchema });
