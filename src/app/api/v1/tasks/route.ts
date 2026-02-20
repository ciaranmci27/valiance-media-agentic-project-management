import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createTaskSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { insertTask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('tasks', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const priority = searchParams.get('priority');
  const projectId = searchParams.get('project_id');
  const assigneeId = searchParams.get('assignee_id');

  // Use !inner join when filtering by assignee so count is accurate
  const assigneeJoin = assigneeId ? 'task_assignees!inner(member_id)' : 'task_assignees(member_id)';
  let query = supabase.from('tasks').select(`
    *,
    ${assigneeJoin},
    subtasks(id, task_id, title, completed, sort_order),
    comments(id, task_id, user_id, text, created_at)
  `, { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (projectId) query = query.eq('project_id', projectId);
  if (assigneeId) query = query.eq('task_assignees.member_id', assigneeId);
  const taskType = searchParams.get('task_type');
  if (taskType) query = query.eq('task_type', taskType);
  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`title.ilike.%${s}%,description.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order(sort, { ascending: order })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const tasks = (data || []).map((t: any) => ({
    ...t,
    assignee_ids: (t.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (t.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (t.comments || []).sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    task_assignees: undefined,
  }));

  return paginated(tasks, { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const { assignee_ids, ...taskData } = body as any;
  const task = await insertTask(supabase, taskData, assignee_ids || []);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/tasks', entityType: 'task', entityId: task.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 201 });
  return created(task);
}, { schema: createTaskSchema });
