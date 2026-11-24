import { removeOwnIdentity } from '@/lib/api/identities';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Unlinks one of the signed-in member's own accounts. Tokens minted for it stop working. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId }) => removeOwnIdentity(service, memberId, (await params).id));
}
