import { agentDetail, patchAgent } from '@/lib/api/agent-workspace';
import { forbidden } from '@/lib/api/errors';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { patchAgentSchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * One agent as the viewer may see it: who it is, rules, health, current run,
 * its assignments on projects the viewer reaches, owners, keys (never a
 * secret; with api_keys.manage_all), webhooks (with webhooks.manage),
 * template_key, can_manage and omitted. Any signed-in member but a guest.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    return agentDetail(service, caller, (await params).id);
  });
}

/**
 * Changes an agent: name, title, description, avatar_url, agent_role and
 * rules (self_assign, close_policy, create_policy, escalate_to) for an Owner,
 * team.manage or one of its owners; owner_ids for an Owner or one of its
 * owners. Answers { agent, rules, owners }.
 */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, patchAgentSchema);
    const { agent, rules, owners } = await patchAgent(service, caller, (await params).id, body);
    return { agent, rules, owners };
  });
}
