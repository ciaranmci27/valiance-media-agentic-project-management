import { trashEntry, updateEntry } from '@/lib/api/initiatives';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateInitiativeEntrySchema } from '@/lib/initiatives';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; initiativeId: string; entryId: string }> };

/** Changes an entry: its author edits title, body and task; status resolves or reopens an issue. */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId, entryId } = await params;
    const body = await readWorkspaceBody(request, updateInitiativeEntrySchema);
    return (await updateEntry(service, caller, id, initiativeId, entryId, body)).entry;
  });
}

/** Moves an entry to Trash (its author, or whoever manages projects). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId, entryId } = await params;
    return trashEntry(service, caller, id, initiativeId, entryId);
  });
}
