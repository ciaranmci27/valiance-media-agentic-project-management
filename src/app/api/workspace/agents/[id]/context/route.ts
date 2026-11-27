import { buildContextPack, contextPackResponse, packKeyFor } from '@/lib/api/agent-context';
import { callerHolds, canManageAgent } from '@/lib/api/agent-owners';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { loadSetupTarget, requireAgentTarget } from '@/lib/api/agent-setup';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * An agent's context pack as the signed-in viewer may see it, the same one
 * GET /api/v1/agents/{id}/context answers: format=md an AGENTS.md file,
 * format=pack { pack }, format=markdown { markdown }, default { pack,
 * markdown }. For team.read or the agent's managers, never a guest. Never cached.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workspaceRoute(request, async ({ service, caller, granter, access }) => {
    // Guests never see the agents, as on every other agents route.
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    requireAgentsEnabled(access);
    const { id } = await params;
    if (!callerHolds(caller, 'team.read') && !callerHolds(caller, 'team.manage') && !(await canManageAgent(service, caller, id))) {
      throw forbidden('Reading an agent\'s context needs team.read, or to be one of its owners', { reason: 'missing_permission' });
    }
    const target = await loadSetupTarget(service, granter, id);
    requireAgentTarget(target, 'An agent context pack');
    const { key, omitted } = await packKeyFor(service, granter, target.id, null);
    const pack = await buildContextPack(service, granter, { memberId: target.id, key, omitted, mode: 'setup' });
    return contextPackResponse(pack, new URL(request.url).searchParams.get('format'));
  });
}
