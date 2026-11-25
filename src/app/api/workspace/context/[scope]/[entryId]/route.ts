import { removeScopedEntry, updateScopedEntry } from '@/lib/api/context-scopes';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { patchScopedEntrySchema } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ scope: string; entryId: string }> };

/** Changes an entry: section, content, pinned. For whoever may write its scope. Answers the entry. */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, patchScopedEntrySchema);
    return (await updateScopedEntry(service, caller, (await params).entryId, body)).entry;
  });
}

/** Removes an entry: archived, or deleted from a person's own memory. Answers { id, deleted }. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { before, deleted } = await removeScopedEntry(service, caller, (await params).entryId);
    return { id: before.id, deleted };
  });
}
