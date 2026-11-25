import { listAgentProfiles } from '@/lib/api/agent-registries';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The agent profiles an Owner picks from on the Team page: core's, the
 * install's, then the workspace's own rows (live ones), each with value,
 * label, description and source. Any signed-in member but a guest, with AI
 * agents on.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    requireAgentsEnabled(access);
    return { profiles: (await listAgentProfiles(service)).map(({ value, label, description, source }) => ({ value, label, description, source })) };
  });
}
