import { groupUsage } from '@/lib/api/groups';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** What a group controls: agents it owns and that escalate to it, inboxes, initiatives, assistant setups. For whoever reads the group. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => groupUsage(service, caller, (await params).id));
}
