import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTaskSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { patchTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows } from '@/lib/api/access';
import { assertBlockersInProject } from '@/lib/api/task-guards';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      *,
      task_assignees(member_id),
      subtasks:task_subtasks(id, task_id, title, completed, sort_order),
      comments:task_comments(id, task_id, user_id, text, created_at),
      criteria:task_acceptance_criteria(id, task_id, criterion, satisfied, sort_order),
      reviews:task_reviews(id, round, verdict, summary, pr_url, head_sha, reviewer_member_id, created_at),
      task_dependencies!task_dependencies_task_id_fkey(
        blocker:tasks!task_dependencies_blocked_by_task_id_fkey(id, title, status)
      )
    `)
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Task');

  const rawDependencies = data.task_dependencies || [];
  const blockedBy = rawDependencies
    .map((d: any) => d.blocker)
    .filter(Boolean);
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
    assignee_ids: (data.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (data.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (data.comments || []).sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    acceptance_criteria: (data.criteria || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    // Newest review row is the task's current verdict; jeff-automerge reads
    // this field and fails closed when it is null. Round breaks created_at
    // ties (same-millisecond rows would otherwise be nondeterministic).
    latest_review: (data.reviews || []).slice().sort((a: any, b: any) =>
      (new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      || ((b.round ?? 0) - (a.round ?? 0))
    )[0] ?? null,
    blocked_by: blockedBy,
    blocked_by_ids: blockedBy.map((b: any) => b.id),
    dependencies_met: unresolvedBlockers === 0 && blockedBy.every((b: any) => b.status === 'done'),
    criteria: undefined,
    reviews: undefined,
    task_dependencies: undefined,
    task_assignees: undefined,
  };

  return success(task);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Task');
  const { assignee_ids, acceptance_criteria, blocked_by_ids, ...updates } = body as any;
  if (assignee_ids !== undefined && !(scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api'))) {
    throw forbidden('Changing task assignments requires the tasks.manage_all API scope');
  }
  const blockedByIds: string[] | undefined = Array.isArray(blocked_by_ids) ? blocked_by_ids : undefined;
  if (blockedByIds !== undefined && blockedByIds.length > 0) {
    await assertBlockersInProject(supabase, blockedByIds, before.project_id, id);
  }
  const criteria: string[] | undefined = Array.isArray(acceptance_criteria) ? acceptance_criteria : undefined;
  const data = await patchTask(supabase, id, updates, assignee_ids, criteria, blockedByIds);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateTaskSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Task');

  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
