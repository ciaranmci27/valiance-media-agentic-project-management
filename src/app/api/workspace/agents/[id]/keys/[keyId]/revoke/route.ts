import { revokeAgentKey } from '@/lib/api/agent-workspace';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Revokes one of an agent's keys, and every live key it made (an Owner or
 * api_keys.manage_all). Answers { revoked: [ids] }, the key itself first;
 * empty when it was already revoked.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; keyId: string }> }) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, keyId } = await params;
    return { revoked: await revokeAgentKey(service, caller, id, keyId) };
  });
}
