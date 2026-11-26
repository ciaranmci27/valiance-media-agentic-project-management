import { setKeyPaused } from '@/lib/api/key-manage';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Resumes a paused key: the same secret works again from its next request.
 * For the key's member, its creator and holders of api_keys.manage_all, as
 * revoke (lib/api/key-manage.ts). Doing it twice answers the key as it is; a
 * revoked or ended key is 409. Answers { data: key } with its state.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access, memberId }) => setKeyPaused(service, {
    memberId, access, apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}/resume`, via: 'app', checkManage: true,
  }, id, false), { noStore: true });
}
