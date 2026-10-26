import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createTaskSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { accessAllows } from '@/lib/api/access';
import { createApiTask } from '@/lib/api/create-task';
import { liveTaskIds } from '@/lib/api/task-guards';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
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
    subtasks:task_subtasks(id, task_id, title, completed, sort_order),
    comments:task_comments(id, task_id, user_id, text, created_at),
    criteria:task_acceptance_criteria(id, task_id, criterion, satisfied, sort_order),
    task_dependencies!task_dependencies_task_id_fkey(blocked_by_task_id)
  `, { count: 'exact' })
    .is('deleted_at', null)
    .is('subtasks.deleted_at', null)
    .is('comments.deleted_at', null);
  if (!accessAllows(access, 'projects.read_all', 'api')) {
    if (access.project_ids.length === 0) return paginated([], { page, limit, total: 0 });
    query = query.in('project_id', access.project_ids);
  }
  // Tasks of a project in Trash went to Trash with it.
  const trashed = await trashedProjectIds(supabase);
  if (trashed.length) query = query.not('project_id', 'in', postgrestList(trashed));

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (projectId) query = query.eq('project_id', projectId);
  if (assigneeId) query = query.eq('task_assignees.member_id', assigneeId);
  const taskType = searchParams.get('task_type');
  if (taskType) query = query.eq('task_type', taskType);
  const aiReadiness = searchParams.get('ai_readiness');
  if (aiReadiness === 'ai_ready' || aiReadiness === 'needs_spec' || aiReadiness === 'human_only') {
    query = query.eq('ai_readiness', aiReadiness);
  }
  const goalId = searchParams.get('project_goal_id');
  if (goalId) query = query.eq('project_goal_id', goalId);
  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`title.ilike.%${s}%,description.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order(sort, { ascending: order })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  // A blocker in Trash blocks nothing (its dependency row waits for a restore).
  const liveBlockers = await liveTaskIds(supabase, (data || []).flatMap((t: { task_dependencies?: { blocked_by_task_id: string }[] | null }) =>
    (t.task_dependencies || []).map((d) => d.blocked_by_task_id)));
  const tasks = (data || []).map((t: any) => ({
    ...t,
    assignee_ids: (t.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (t.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (t.comments || []).sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    acceptance_criteria: (t.criteria || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    blocked_by_ids: (t.task_dependencies || []).map((d: any) => d.blocked_by_task_id).filter((id: string) => liveBlockers.has(id)),
    criteria: undefined,
    task_dependencies: undefined,
    task_assignees: undefined,
  }));

  return paginated(tasks, { page, limit, total: count || 0 });
});

export const POST = withApi(async (ctx) => {
  return created(await createApiTask(ctx, '/api/v1/tasks'));
}, { schema: createTaskSchema });
