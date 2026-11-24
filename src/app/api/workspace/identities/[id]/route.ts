import { adminUnlinkIdentity } from '@/lib/api/identities';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Unlinks anyone's account (an Owner or team.manage); delegation tokens minted for it stop working. Answers { removed }. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => adminUnlinkIdentity(service, caller, (await params).id));
}
