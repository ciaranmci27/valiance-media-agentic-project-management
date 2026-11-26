import { endAiSetup } from '@/lib/api/ai-setup';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Ends one of the signed-in person's AI setup sessions now (a setup key stops working at once). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    await endAiSetup(service, memberId, (await params).id);
    return { ended: true };
  });
}
