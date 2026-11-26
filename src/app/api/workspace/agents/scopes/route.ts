import { newAgentScopes } from '@/lib/api/agent-config';
import { callerHolds } from '@/lib/api/agent-owners';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The API scopes a new agent can hold (what its role grants on the API
 * channel, before any override): { scopes: [...] }. The hire flow offers
 * only these, so a hire never fails on a power the agent role lacks
 * (the hire's own check, scope_not_held, reads the same set). An Owner or a
 * holder of api_keys.manage_all, with AI agents on.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller, granter, access }) => {
    requireAgentsEnabled(access);
    if (access.role !== 'owner' && !callerHolds(caller, 'api_keys.manage_all')) {
      throw forbidden('Only an Owner, or someone who manages every key, reads what a new agent can hold', { reason: 'owner_only' });
    }
    return { scopes: [...(await newAgentScopes(service, granter))].sort() };
  });
}
