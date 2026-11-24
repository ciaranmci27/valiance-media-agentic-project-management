import { removeBriefEntry, updateBriefEntry } from '@/lib/api/project-brief';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateBriefEntrySchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; entryId: string }> };

/** Changes an entry: section, content, pinned. For project_context.manage. Answers the entry. */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, updateBriefEntrySchema);
    const { id, entryId } = await params;
    return (await updateBriefEntry(service, caller, id, entryId, body)).entry;
  });
}

/** Archives an entry (is_active false), as the API's DELETE always has. Answers the entry. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, entryId } = await params;
    return (await removeBriefEntry(service, caller, id, entryId)).entry;
  });
}
