import { mintAgentKey } from '@/lib/api/agent-workspace';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { agentKeySchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

/**
 * Makes a key for an agent, by the setup API's rules (an Owner, with
 * api_keys.manage_all; every scope held by the agent and by the signed-in
 * Owner). Answers { key: { id, name, prefix, scopes, permissions, secret } }:
 * the secret is the only copy. Never cached.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workspaceRoute(request, async ({ service, caller, granter }) => {
    const body = await readWorkspaceBody(request, agentKeySchema);
    return { key: await mintAgentKey(service, caller, granter, (await params).id, body) };
  }, { status: 201, noStore: true });
}
