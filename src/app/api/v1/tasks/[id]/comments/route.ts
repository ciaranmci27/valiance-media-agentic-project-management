import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createCommentSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertComment } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('task_comments')
    .select('*', { count: 'exact' })
    .eq('task_id', id)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: task } = await supabase.from('tasks').select('id').eq('id', id).maybeSingle();
  if (!task) throw notFound('Task');

  const { user_id, text } = body as any;
  const comment = await insertComment(supabase, id, user_id, text);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/comments`, entityType: 'comment', entityId: comment.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: comment, statusCode: 201 });
  return created(comment);
}, { schema: createCommentSchema });
