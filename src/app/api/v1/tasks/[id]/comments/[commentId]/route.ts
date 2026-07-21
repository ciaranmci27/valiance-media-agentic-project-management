import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateCommentSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { accessAllows } from '@/lib/api/access';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id, commentId } = params as any;
  const { data: before } = await supabase.from('task_comments').select('*').eq('id', commentId).eq('task_id', id).maybeSingle();
  if (!before) throw notFound('Comment');
  if (before.user_id !== teamMemberId && !(scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api'))) {
    throw forbidden('This API key can only edit its own comments');
  }

  const { data, error } = await supabase
    .from('task_comments')
    .update(body)
    .eq('id', commentId)
    .eq('task_id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Comment');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}/comments/${commentId}`, entityType: 'comment', entityId: commentId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateCommentSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access, scopes }) => {
  const { id, commentId } = params as any;
  const { data: before } = await supabase.from('task_comments').select('*').eq('id', commentId).eq('task_id', id).maybeSingle();
  if (!before) throw notFound('Comment');
  if (before.user_id !== teamMemberId && !(scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api'))) {
    throw forbidden('This API key can only delete its own comments');
  }

  const { error } = await supabase
    .from('task_comments')
    .delete()
    .eq('id', commentId)
    .eq('task_id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/comments/${commentId}`, entityType: 'comment', entityId: commentId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
