import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as any;
  const { data: before } = await supabase.from('subtasks').select('*').eq('id', subtaskId).maybeSingle();

  const { data, error } = await supabase
    .from('subtasks')
    .update(body)
    .eq('id', subtaskId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Subtask');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'subtask', entityId: subtaskId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateSubtaskSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as any;
  const { data: before } = await supabase.from('subtasks').select('*').eq('id', subtaskId).maybeSingle();

  const { error } = await supabase
    .from('subtasks')
    .delete()
    .eq('id', subtaskId);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'subtask', entityId: subtaskId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
