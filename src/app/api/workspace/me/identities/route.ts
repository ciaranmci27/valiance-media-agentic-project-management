import { ownIdentities } from '@/lib/api/identities';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/** The signed-in member's linked accounts, verified or not. Answers { identities }. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => ({ identities: await ownIdentities(service, memberId) }));
}
