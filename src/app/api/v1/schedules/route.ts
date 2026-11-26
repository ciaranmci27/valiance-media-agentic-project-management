import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listSchedules, scheduleFiltersFrom } from '@/lib/api/schedules';

/**
 * Schedules on projects the key's member can open, soonest next first:
 * template schedules and task repeats. Filters: kind (template, task),
 * template_id, task_id, project_id, status (active, paused, ended).
 * Permission: tasks.read or tasks.create (template schedules need tasks.create or templates.manage).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listSchedules(supabase, { memberId: teamMemberId, access, scopes }, { ...scheduleFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.read', 'tasks.create', 'templates.manage'] });
