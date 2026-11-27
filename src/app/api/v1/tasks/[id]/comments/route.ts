import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createCommentSchema } from '@/lib/schemas';
import { ApiError, notFound } from '@/lib/api/errors';
import { insertComment } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination, readPage } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await readPage(supabase
    .from('task_comments')
    .select('*', { count: 'exact' })
    .eq('task_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id'), { offset, limit });

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'tasks.read' });

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access }) => {
  const { id } = params as any;

  const { data: task } = await supabase.from('tasks').select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!task) throw notFound('Task');

  const { text, blocked } = body as { text: string; blocked?: boolean };
  // Blocked is an agent saying it is stuck: a person's comment never is (the
  // database keeps it false too), so asking for it is refused, not ignored.
  if (blocked && access?.role !== 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only an agent marks its comment blocked; ask_human or a reply is how a person answers', { reason: 'blocked_agents_only' });
  }
  const comment = await insertComment(supabase, id, teamMemberId, text, blocked === true);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/comments`, entityType: 'comment', entityId: comment.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: comment, statusCode: 201 });
  return created(comment);
}, { schema: createCommentSchema, permission: 'tasks.read' });
