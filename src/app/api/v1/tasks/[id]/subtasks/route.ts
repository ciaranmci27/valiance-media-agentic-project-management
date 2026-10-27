import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { nextSubtaskOrder, subtaskRuleError, subtaskSummaries } from '@/lib/api/subtasks';

// Kept for callers of the old text subtasks: a subtask is now a task with
// parent_task_id (POST /api/v1/tasks with parent_task_id makes a full one).
// The middleware has authorized the parent in the URL; working its subtasks
// comes with managing it.

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as { id: string };
  const { page, limit, offset } = parsePagination(searchParams);
  const all = (await subtaskSummaries(supabase, [id])).get(id) ?? [];
  return paginated(all.slice(offset, offset + limit), { page, limit, total: all.length });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as { id: string };

  const { data: parent } = await supabase
    .from('tasks')
    .select('id, project_id, parent_task_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!parent) throw notFound('Task');

  let task;
  try {
    task = await insertTask(supabase, {
      project_id: parent.project_id,
      parent_task_id: parent.id,
      sort_order: await nextSubtaskOrder(supabase, parent.id),
      title: (body as { title: string }).title,
      description: '',
      status: 'todo',
      priority: 'medium',
      due_date: null,
      tags: [],
      created_by: teamMemberId || null,
    }, []);
  } catch (error) {
    throw subtaskRuleError(error);
  }
  const subtask = { id: task.id, task_id: parent.id, title: task.title, status: task.status, completed: false, assignee_ids: [], due_date: null, sort_order: task.sort_order ?? 0 };
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/subtasks`, entityType: 'task', entityId: task.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: subtask, statusCode: 201 });
  return created(subtask);
}, { schema: createSubtaskSchema });
