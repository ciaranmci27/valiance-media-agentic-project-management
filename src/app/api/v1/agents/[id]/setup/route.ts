import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { agentSetup } from '@/lib/api/agent-setup';

/**
 * An agent's whole setup in one read, so whoever configured it can check it:
 * the member, its rules, its projects and project reach, its live API keys
 * (never a secret) with the scopes a key for it may carry, and the webhook
 * endpoints filtered to it (never a signing secret). Keys need
 * api_keys.manage_all and webhooks need webhooks.manage; without one that
 * part is null and named in omitted.
 *
 * Permission: team.read, with the AI agents module on.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  requireAgentsEnabled(access);
  return success(await agentSetup(supabase, { memberId: teamMemberId, access, scopes }, params.id));
}, { permission: 'team.read' });
