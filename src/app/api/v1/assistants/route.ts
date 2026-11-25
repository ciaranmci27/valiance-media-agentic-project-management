import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listPersonalAgents } from '@/lib/api/personal-agents';

/**
 * Personal agents, by name, paged: each with its person, template, status
 * and live keys (never a secret). needs_key=true lists the active ones with
 * no live key, which the harness then collects with POST
 * /api/v1/assistants/{id}/key; person_id narrows to one person.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access, scopes, teamMemberId, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const result = await listPersonalAgents(supabase, { memberId: teamMemberId, access, scopes }, {
    needsKey: searchParams.get('needs_key') === 'true', personId: searchParams.get('person_id'), offset, limit,
  });
  return paginated(result.rows, { page, limit, total: result.total });
}, { permission: 'assistants.provision' });
