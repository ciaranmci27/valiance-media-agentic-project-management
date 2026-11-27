import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { apiConnectionView, setConnectionAgents } from '@/lib/chat/connections';
import { chatConnectionAgentsSchema, type ChatConnectionAgentsInput } from '@/lib/chat/types';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * Which company agents a company connection reaches (agent_ids, the whole
 * list) and the one a DM goes to (default_agent_id, one of them, or null),
 * as Settings > Assistants > Chat apps does. Each must be a shared agent
 * that may act for people (422 agent_cannot_act_for, personal_agent,
 * not_an_agent). Agents left out lose their channel mappings. 409
 * not_a_company_connection for a personal one. Answers the connection with
 * its health. An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const PUT = withApi<ChatConnectionAgentsInput, { id: string }>(async ({ supabase, params, body, access, teamMemberId, apiKeyId, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const view = await setConnectionAgents(supabase, access, teamMemberId, params.id, body, appUrlFor(origin), { endpoint: `/api/v1/chat/connections/${params.id}/agents`, apiKeyId });
  return success(apiConnectionView(view));
}, { schema: chatConnectionAgentsSchema, permission: 'team.manage' });
