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

  // Idempotency is per COMMIT, and deliberately not per (commit, verdict).
  //
  // Reviewer turns overlap: a dispatcher wake and the standing cron land close
  // together, and the second turn starts before the first verdict exists. When
  // both reach the SAME conclusion the old rule was enough. When they disagree
  // about identical bytes it was not, and the cost was real: one PR reached
  // eleven rounds because four commits each received both verdicts, including
  // an approval undone twelve minutes later by a contradicting review of the
  // very same SHA. That sent the developer back to rebuild already-approved
  // work, on the client's bill.
  //
  // The same bytes cannot be both approved and rejected, so the first verdict
  // on a commit is the verdict. A reviewer that genuinely changes its mind says
  // so on the next commit, which is the only place new evidence can live.
  const { data: existing } = await supabase
    .from('task_reviews')
    .select('*')
    .eq('task_id', id)
    .eq('pr_url', pr_url)
    .eq('head_sha', head_sha.toLowerCase())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return created(existing);

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
  const round = (count || 0) + 1;
  const { data: review, error } = await supabase
    .from('task_reviews')
    .insert({
      task_id: id,
      round,
      verdict,
      summary,
      pr_url,
      head_sha: head_sha.toLowerCase(),
      reviewer_member_id: teamMemberId || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  // An APPROVED verdict changes nothing on the task itself: it stays in
  // in_review and only this row is written. The host dispatcher wakes agents
  // from task timestamps, so without this touch the one path that should be
  // fastest (approve, then merge) was the only one that waited for the next
  // 30-minute tick. A changes_requested verdict already moves the task, so it
  // never had the problem. Best effort: a failed touch costs latency, never
  // the verdict.
  // Circuit breaker. A loop still bouncing after this many rounds is not
  // converging, and every further round is billable developer time spent
  // reworking code a reviewer has already seen. Handing it to a human costs
  // one decision; letting it grind costs hours, silently. The developer agent
  // claims only `ai_ready` work, so this stops the loop without touching the
  // branch, the PR, or the review history, and the task surfaces in the
  // owner's "needs you" lane instead of disappearing into another cycle.
  const MAX_AUTONOMOUS_ROUNDS = 5;
  const stalled = round > MAX_AUTONOMOUS_ROUNDS && verdict === 'changes_requested';

  await supabase
    .from('tasks')
    .update({
      updated_at: new Date().toISOString(),
      ...(stalled ? { ai_readiness: 'human_only' } : {}),
    })
    .eq('id', id);

  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/reviews`, entityType: 'task_review', entityId: review.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: review, statusCode: 201 });
  return created(review);
}, { schema: createTaskReviewSchema });
