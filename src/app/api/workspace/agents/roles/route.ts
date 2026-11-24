import { agentRoles } from '@/lib/api/agent-workspace';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The role labels agents carry, most used first, for filter chips built
 * from real data: { roles: ['builder', ...], counts: { builder: 3 } }.
 * Any signed-in member but a guest.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    requireAgentsEnabled(access);
    return agentRoles(service);
  });
}
