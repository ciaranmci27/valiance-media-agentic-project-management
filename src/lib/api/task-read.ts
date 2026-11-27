import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound } from './errors';
import { subtaskSummaries } from './subtasks';
import { claimWithName } from './claims';
import { openQuestionForTask } from './questions';
import { latestRunForTask } from './agent-runs';

/**
 * One task in full, as GET /api/v1/tasks/{id} answers it: its parent (for a
 * subtask), subtasks, acceptance criteria, every live comment oldest first,
 * the latest review, blockers with dependencies_met, the live claim, the
 * open question and the latest agent run (null while the AI agents module
 * is off: agentsOn). The task brief reads the same. Access is the caller's to
 * check (withApi does, for both routes); this only reads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field, as the route always did
export type TaskRow = Record<string, any>;

export async function readTaskInFull(supabase: SupabaseClient, taskId: string, options: {
  agentsOn: boolean;
  /**
   * The reader when they are a guest (null otherwise): only a question
   * addressed to them shows as the open question. Required, so every
   * caller decides.
   */
  guestId: string | null;
}): Promise<TaskRow> {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      *,
      task_assignees(member_id),
      comments:task_comments(id, task_id, user_id, text, created_at),
      criteria:task_acceptance_criteria(id, task_id, criterion, satisfied, sort_order),
      reviews:task_reviews(id, round, verdict, summary, pr_url, head_sha, reviewer_member_id, created_at),
      task_dependencies!task_dependencies_task_id_fkey(
        blocker:tasks!task_dependencies_blocked_by_task_id_fkey(id, title, status, deleted_at)
      )
    `)
    .eq('id', taskId)
    .is('deleted_at', null)
    .is('comments.deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Task');

  // A subtask names its parent; a parent lists its subtasks.
  let parent: { id: string; title: string; status: string } | null = null;
  if (data.parent_task_id) {
    const { data: parentRow, error: parentError } = await supabase
      .from('tasks')
      .select('id, title, status')
      .eq('id', data.parent_task_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (parentError) throw parentError;
    parent = parentRow;
  }
  const subtasks = (await subtaskSummaries(supabase, [data.id])).get(data.id) ?? [];

  // A blocker in Trash blocks nothing, as deleting it used to remove the
  // dependency. (The same project, so it cannot be in a trashed project.)
  type Blocker = { id: string; title: string; status: string; deleted_at: string | null };
  const rawDependencies = ((data.task_dependencies || []) as { blocker: Blocker | null }[])
    .filter((d) => !d.blocker?.deleted_at);
  const blockedBy = rawDependencies
    .map((d) => d.blocker)
    .filter((blocker): blocker is Blocker => !!blocker)
    .map((blocker) => ({ id: blocker.id, title: blocker.title, status: blocker.status }));
  // A blocker the caller cannot resolve is still a blocker. filter(Boolean)
  // drops rows whose joined task is hidden by project scoping or RLS, and
  // .every() on what survives then reports dependencies_met: true. The agent
  // reads that as cleared and starts work that is genuinely blocked.
  //
  // Same failure shape as blanking a project's operating parameters, in the
  // other direction: a read path returning a plausible value instead of
  // refusing. Unresolved rows now fail closed.
  const unresolvedBlockers = rawDependencies.length - blockedBy.length;

  const task = {
    ...data,
    assignee_ids: (data.task_assignees || []).map((ta: TaskRow) => ta.member_id),
    parent,
    subtasks,
    comments: (data.comments || []).sort((a: TaskRow, b: TaskRow) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    acceptance_criteria: (data.criteria || []).sort((a: TaskRow, b: TaskRow) => a.sort_order - b.sort_order),
    // Newest review row is the task's current verdict; an automerge script reads
    // this field and fails closed when it is null. Round breaks created_at
    // ties (same-millisecond rows would otherwise be nondeterministic).
    latest_review: (data.reviews || []).slice().sort((a: TaskRow, b: TaskRow) =>
      (new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      || ((b.round ?? 0) - (a.round ?? 0))
    )[0] ?? null,
    blocked_by: blockedBy,
    blocked_by_ids: blockedBy.map((b) => b.id),
    dependencies_met: unresolvedBlockers === 0 && blockedBy.every((b) => b.status === 'done'),
    // Who is working on it right now (a live claim), or null.
    claim: await claimWithName(supabase, data),
    // The task is waiting on someone: its oldest open question, or null.
    open_question: await openQuestionForTask(supabase, data.id, options.guestId ? { memberId: options.guestId } : null),
    // The newest agent run on it (status, agent, start, trace link), or null.
    latest_run: options.agentsOn ? await latestRunForTask(supabase, data.id) : null,
    criteria: undefined,
    reviews: undefined,
    task_dependencies: undefined,
    task_assignees: undefined,
  };

  return task;
}
