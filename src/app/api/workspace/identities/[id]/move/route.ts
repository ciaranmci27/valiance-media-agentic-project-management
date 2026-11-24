import { adminMoveIdentity } from '@/lib/api/identities';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { moveIdentitySchema } from '@/lib/identities';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Moves an account to another member (an Owner or team.manage): unlinked, then linked to them verified as admin. Answers { removed, linked }. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, moveIdentitySchema);
    return adminMoveIdentity(service, caller, (await params).id, body.member_id);
  });
}
