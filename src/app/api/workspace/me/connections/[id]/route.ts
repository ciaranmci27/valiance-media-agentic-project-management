import { disconnect } from '@/lib/api/connect-ai';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Disconnect: one of the signed-in person's connected apps stops working at once (every token and its key). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    await disconnect(service, memberId, (await params).id);
    return { disconnected: true };
  });
}
