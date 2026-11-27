import { agentTree } from '@/lib/api/agent-hierarchy';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/** The chart of company agents, as GET /api/v1/agents/tree answers it. Any signed-in member but a guest. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    return agentTree(service, caller);
  });
}
