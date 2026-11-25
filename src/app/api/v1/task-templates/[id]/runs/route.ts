import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listRuns } from '@/lib/api/task-templates';

/**
 * A template's runs, newest first, paged: who used it, how (app, api, mcp),
 * the project, start date, fill-in values, the version it was at and every
 * task it made. Only runs on projects the key's member can open.
 *
 * Permission: tasks.create or templates.manage.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listRuns(supabase, { memberId: teamMemberId, access, scopes }, params.id, { offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.create', 'templates.manage'] });
