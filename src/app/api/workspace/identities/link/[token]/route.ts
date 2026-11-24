import { confirmLinkRequest, readLinkRequest } from '@/lib/api/identities';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string }> };

/** What a link asks the signed-in member to confirm: the account, who asked, and whether it is still open. Never cached. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId }) => readLinkRequest(service, (await params).token, memberId), { noStore: true });
}

/**
 * Confirms the link: the account is stored as verified for the signed-in
 * member (method link), and the link is used up. 409 link_used, 410
 * link_expired, 403 wrong_member, 409 identity_linked_elsewhere.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId, access }) =>
    confirmLinkRequest(service, (await params).token, { id: memberId, role: access.role }), { noStore: true });
}
