import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listOccurrences } from '@/lib/api/schedules';

/**
 * What a schedule made, skipped or failed, newest date first: status
 * (created, skipped, failed), reason, error, attempts, run_id or task_id.
 * Permission: tasks.read or tasks.create.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listOccurrences(supabase, { memberId: teamMemberId, access, scopes }, params.id, { offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.read', 'tasks.create', 'templates.manage'] });
