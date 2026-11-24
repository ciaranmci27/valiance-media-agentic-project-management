import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { exportAgentConfig } from '@/lib/api/agent-config';

/**
 * An agent's configuration as a versioned document (format pm-agent-config,
 * version 1) that POST /api/v1/agents/import reads back, here or in another
 * install: the member's name, title and profile, its rules (the escalation
 * target by id and name), its projects by id and name, its live keys' names
 * and scopes, the webhook endpoints filtered to it (URL, events, project
 * filter, never the signing secret) and the template it was set up from.
 * Never a secret or a hash. Keys need api_keys.manage_all and webhooks
 * webhooks.manage; without one that part is null and named in omitted.
 *
 * Permission: team.read, with the AI agents module on (as get_agent_setup).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  requireAgentsEnabled(access);
  return success(await exportAgentConfig(supabase, { memberId: teamMemberId, access, scopes }, params.id));
}, { permission: 'team.read' });
