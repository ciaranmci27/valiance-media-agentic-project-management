import { restoreInitiative } from '@/lib/api/initiatives';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; initiativeId: string }> };

/** Brings an initiative back from Trash, its tasks with it (an Undo after a delete). */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    return restoreInitiative(service, caller, id, initiativeId);
  });
}
