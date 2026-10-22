import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as any;
  const { data: before } = await supabase.from('task_subtasks').select('*').eq('id', subtaskId).eq('task_id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Subtask');

  const { data, error } = await supabase
    .from('task_subtasks')
    .update(body)
    .eq('id', subtaskId)
    .eq('task_id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Subtask');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'subtask', entityId: subtaskId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateSubtaskSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as any;
  const { data: before } = await supabase.from('task_subtasks').select('*').eq('id', subtaskId).eq('task_id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Subtask');

  await trashForApi(supabase, 'task_subtasks', subtaskId, teamMemberId, 'Subtask');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'subtask', entityId: subtaskId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
