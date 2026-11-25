import { accountSignInView } from '@/lib/api/sign-in';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The signed-in member's own sign-in (Settings > Account): their login
 * email, whether it has a password, whether Google is linked, the
 * workspace's sign-in methods, and why each change would be refused.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, authUserId }) => accountSignInView(service, { memberId, authUserId }), { noStore: true });
}
