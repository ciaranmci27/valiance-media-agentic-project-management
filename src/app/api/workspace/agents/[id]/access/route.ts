import { getAgentAccess, setAgentAccess, setAgentAccessSchema } from '@/lib/api/agent-hierarchy';
import { forbidden } from '@/lib/api/errors';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * An agent's Access section: who can use it (with exceptions), the limits
 * its orchestrators put on it in plain words, "N people can use it", its orchestrator and
 * the agents under it, Reachable directly, Ask first, and whether the viewer
 * may change it. Any signed-in member but a guest.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    return getAgentAccess(service, caller, (await params).id);
  });
}

/**
 * Sets its orchestrator, Reachable directly, Ask first and who can use it, by the
 * same rules as PUT /api/v1/agents/{id}/access. Answers the access as GET does.
 */
export async function PUT(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, setAgentAccessSchema);
    return setAgentAccess(service, caller, (await params).id, body);
  });
}
