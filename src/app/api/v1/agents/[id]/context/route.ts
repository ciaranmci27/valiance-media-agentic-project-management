import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { loadSetupTarget, requireAgentTarget } from '@/lib/api/agent-setup';
import { buildContextPack, contextPackResponse, packKeyFor } from '@/lib/api/agent-context';
import { badRequest, forbidden } from '@/lib/api/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An agent's context pack, for whoever sets it up: the same pack the agent's
 * own key gets from pm_guide (GET /api/v1/agents/me/context), as one of its
 * keys sees it. key_id picks the key; left out, its newest live key; with no
 * key, the scopes it holds. As in get_agent_setup, its scopes and tools need
 * api_keys.manage_all and its webhooks webhooks.manage: without one that
 * part is null and named in omitted. Projects the caller cannot reach are
 * never named. Never a secret.
 *
 * format=json (default) answers { pack, markdown }, format=pack { pack } and
 * format=markdown { markdown }; format=md an AGENTS.md file, format=skill a
 * SKILL.md file. Never cached.
 *
 * Permission: team.read, with the AI agents module on (as get_agent_setup).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId, searchParams }) => {
  // Guests never see the agents, as on every other agents route.
  if (access.role === 'guest') throw forbidden('Guests do not see the agents');
  requireAgentsEnabled(access);
  const viewer = { memberId: teamMemberId, access, scopes };
  const target = await loadSetupTarget(supabase, viewer, params.id);
  requireAgentTarget(target, 'An agent context pack');
  const keyId = searchParams.get('key_id');
  if (keyId && !UUID.test(keyId)) throw badRequest('key_id must be an API key id');
  const { key, omitted } = await packKeyFor(supabase, viewer, target.id, keyId);
  const pack = await buildContextPack(supabase, viewer, { memberId: target.id, key, omitted, mode: 'setup' });
  return contextPackResponse(pack, searchParams.get('format'));
}, { permission: 'team.read' });
