import { getInitiative, trashInitiative, updateInitiative } from '@/lib/api/initiatives';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateInitiativeSchema } from '@/lib/initiatives';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; initiativeId: string }> };

/** The initiative page's read: header, open issues, recent entries, pinned brief and what the member may do. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    return getInitiative(service, caller, id, initiativeId);
  });
}

/** Changes an initiative: only what is sent (tasks.create in the project). */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    const body = await readWorkspaceBody(request, updateInitiativeSchema);
    return (await updateInitiative(service, caller, id, initiativeId, body)).initiative;
  });
}

/** Moves an initiative to Trash; its tasks keep the link (projects.manage, or whoever made it). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    return trashInitiative(service, caller, id, initiativeId);
  });
}
