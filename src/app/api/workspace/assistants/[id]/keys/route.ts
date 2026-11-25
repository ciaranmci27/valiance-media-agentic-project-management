import { mintOwnPersonalAgentKey } from '@/lib/api/personal-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { assistantKeySchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * A key for your own personal agent: its template's scopes by default (or
 * scopes), each held by the agent with you and by you, so the key never
 * does more than you can. Someone else's personal agent reads as missing.
 * The secret is in this answer only. Answers { key, secret, left_out }.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, memberId, access, granter }) => {
    const body = await readWorkspaceBody(request, assistantKeySchema);
    return mintOwnPersonalAgentKey(service, { memberId, access }, granter, id, body);
  }, { status: 201, noStore: true });
}
