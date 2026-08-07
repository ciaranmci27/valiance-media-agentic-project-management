import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createTaskReviewSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('task_reviews')
    .select('*', { count: 'exact' })
    .eq('task_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

// Writing a review requires tasks.manage_all (enforced in inferredPermission):
// the reviewer is deliberately never an assignee, and an assignee-scoped agent
// must never be able to approve its own work.
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: task } = await supabase.from('tasks').select('id').eq('id', id).maybeSingle();
  if (!task) throw notFound('Task');

  // Independence is enforced by scope (writing reviews needs tasks.manage_all,
  // which the developer key lacks), but scopes are one config mistake away
  // from drifting. This is the structural backstop: whoever is assigned to
  // the task can never review it, no matter what their key says.
  if (teamMemberId) {
    const { data: assignment } = await supabase
      .from('task_assignees')
      .select('member_id')
      .eq('task_id', id)
      .eq('member_id', teamMemberId)
      .maybeSingle();
    if (assignment) throw forbidden('Task assignees cannot review their own work');
  }

  const { verdict, summary, pr_url, head_sha } = body as any;

  // Round is derived server-side so callers cannot reset the escalation
  // counter, and it is scoped to the PR: a replacement PR for the same task
  // starts at round 1 instead of inheriting the abandoned PR's rounds. count
  // is exact under the single-reviewer design; a duplicate round number from
  // a concurrent write would only accelerate escalation, never suppress it.
  const { count, error: countError } = await supabase
    .from('task_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', id)
    .eq('pr_url', pr_url);
  if (countError) throw countError;
  const { data: review, error } = await supabase
    .from('task_reviews')
    .insert({
      task_id: id,
      round: (count || 0) + 1,
      verdict,
      summary,
      pr_url,
      head_sha: head_sha.toLowerCase(),
      reviewer_member_id: teamMemberId || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/reviews`, entityType: 'task_review', entityId: review.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: review, statusCode: 201 });
  return created(review);
}, { schema: createTaskReviewSchema });
