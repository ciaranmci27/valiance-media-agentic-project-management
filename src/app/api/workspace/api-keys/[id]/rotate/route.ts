import { rotateApiKey } from '@/lib/api/key-rotate';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { rotateApiKeySchema } from '@/lib/schemas/api-keys';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Replaces a key: the successor's secret is in this answer only, and the old
 * key keeps working for overlap_hours (default 24, 0 to 168), then ends.
 * For your own key, your own personal agent's, or (an Owner with
 * api_keys.manage_all) an agent's; minting's rules apply. Answers
 * { key, secret, previous: { id, expires_at } }.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, caller, granter }) => {
    const body = await readWorkspaceBody(request, rotateApiKeySchema);
    return rotateApiKey(service, { caller, granter, apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}/rotate`, via: 'app' }, id, body);
  }, { status: 201, noStore: true });
}
