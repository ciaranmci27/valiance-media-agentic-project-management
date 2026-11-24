import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listProjectAgents } from '@/lib/api/project-agents';

/**
 * The agents on a project, newest first, paged: each with its status,
 * template, settings, instructions and the template's settings form. An
 * agent's key sees only its own assignment. Filters: status, template.
 *
 * Permission: projects.read, with the AI agents module on.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const result = await listProjectAgents(supabase, { memberId: teamMemberId, access, scopes }, params.id, {
    status: searchParams.get('status'), template: searchParams.get('template'), offset, limit,
  });
  return paginated(result.rows, { page, limit, total: result.total });
}, { permission: 'projects.read' });
