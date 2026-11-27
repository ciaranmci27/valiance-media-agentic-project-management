import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { assertHostKeyOwner, hostKeyView, setHostAgentsSchema, setHostKeyAgents, type SetHostAgents } from '@/lib/api/host-keys';

/**
 * The agents a host key serves (a key that carries agents.host, an
 * Owner's): agent_ids and their names. Only an Owner reads it.
 *
 * Permission: api_keys.manage_all (an Owner's key).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access }) => {
  await assertHostKeyOwner(supabase, { access }, params.id);
  return success(await hostKeyView(supabase, params.id));
}, { permission: 'api_keys.manage_all' });

/**
 * Binds a host key to the agents it serves (replaces the list; [] serves
 * none). Only an Owner (403 owner_only), only for a live key that carries
 * agents.host and is an Owner's (422 not_a_host_key, host_key_not_owner),
 * and only active agents (422 not_an_agent), at most 200. With it, the
 * host reads those agents' events (GET /api/v1/events?agents=) and claims,
 * extends and releases their tasks, chat messages and conversations, in
 * their names. It never replies, marks anything handled, reads content
 * beyond the feed or acts for anyone.
 *
 * Permission: api_keys.manage_all (an Owner's key).
 */
export const PUT = withApi<SetHostAgents, { id: string }>(async ({ supabase, params, body, access, apiKeyId, teamMemberId }) => {
  const after = await setHostKeyAgents(supabase, { access }, params.id, body);
  logAudit(supabase, {
    method: 'PUT', endpoint: `/api/v1/api-keys/${params.id}/agents`, entityType: 'api_key', entityId: params.id, apiKeyId, teamMemberId,
    requestBody: body, afterSnapshot: after, statusCode: 200,
  });
  return success(after);
}, { schema: setHostAgentsSchema, permission: 'api_keys.manage_all' });
