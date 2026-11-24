import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination } from '@/lib/api/pagination';
import { listAgentAssignments } from '@/lib/api/project-agents';

/**
 * The calling key's own assignments: each project it is on as an agent, with
 * its status, template, settings and instructions there, newest first,
 * paged. Filters: status (active or paused), template. A member reads only
 * its own.
 *
 * Permission: any API scope the key carries and its member holds, with the
 * AI agents module on.
 */
export const GET = withApi(async ({ supabase, access, scopes, teamMemberId, searchParams }) => {
  requireAgentsEnabled(access);
  const { page, limit, offset } = parsePagination(searchParams);
  const result = await listAgentAssignments(supabase, { memberId: teamMemberId, access, scopes }, teamMemberId, {
    status: searchParams.get('status'), template: searchParams.get('template'), offset, limit,
  });
  return paginated(result.rows, { page, limit, total: result.total });
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
