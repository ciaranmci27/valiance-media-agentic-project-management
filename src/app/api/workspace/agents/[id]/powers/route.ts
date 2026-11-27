import { getAgentPowers, setAgentPowers, setAgentPowersSchema } from '@/lib/api/agent-powers';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * What a company agent may do, as one list: its live keys' scopes and the
 * powers given to it on its own, with whether they are out of step and
 * whether the viewer may change it (lib/api/agent-powers.ts). For who
 * manages every API key.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getAgentPowers(service, caller, (await params).id));
}

/**
 * Saves the list onto every live key and takes away an own power left out,
 * by the key edit's rules (an Owner adds what its role lacks). Answers the
 * list as GET does.
 */
export async function PUT(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, setAgentPowersSchema);
    return setAgentPowers(service, caller, (await params).id, body);
  });
}
