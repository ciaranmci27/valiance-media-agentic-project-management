import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createCommentSchema } from '@/lib/schemas';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { insertComment } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination, readPage } from '@/lib/api/pagination';
import { keyHoldsAny } from '@/lib/api/event-feed';
import { sendGateRefusal } from '@/lib/api/write-gate';
import { announceTaskComment } from '@/lib/api/task-comment-notice';

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

/**
 * Adds a comment under the key's member. notify: true also tells the task's
 * people (its assignees and its creator, never the author) in the bell, in
 * plain words composed here from the comment: it needs notifications.send
 * as well (403 otherwise, before anything is written), and an agent's
 * comment then counts against its send_rate_per_minute (429
 * send_rate_limited, nothing written).
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id } = params as any;
  const { text, notify } = body as { text: string; notify?: boolean };

  if (notify === true && !keyHoldsAny(access, scopes, ['notifications.send'])) {
    throw forbidden('notify needs notifications.send on this key and its member', {
      reason: 'missing_permission', needs: 'notifications.send',
      hint: 'Post the comment without notify, or add notifications.send to the key.',
    });
  }

  const { data: task } = await supabase.from('tasks').select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!task) throw notFound('Task');

  // Blocked is an agent saying it is stuck: a person's comment never is (the
  // database keeps it false too), so asking for it is refused, not ignored.
  const { blocked } = body as { blocked?: boolean };
  if (blocked && access?.role !== 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only an agent marks its comment blocked; ask_human or a reply is how a person answers', { reason: 'blocked_agents_only' });
  }
  if (notify === true && access.role === 'agent') {
    const limited = await sendGateRefusal(supabase, teamMemberId);
    if (limited) throw limited;
  }

  const comment = await insertComment(supabase, id, teamMemberId, text, blocked === true);
  const answer = notify === true
    ? { ...comment, notified: await announceTaskComment(comment).catch((error) => {
      console.error(`[comments] the notice for comment ${comment.id} failed:`, error);
      return 0;
    }) }
    : comment;
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/comments`, entityType: 'comment', entityId: comment.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: answer, statusCode: 201 });
  return created(answer);
}, { schema: createCommentSchema, permission: 'tasks.read' });
