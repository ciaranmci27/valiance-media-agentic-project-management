import { getGroup, trashGroup, updateGroup } from '@/lib/api/groups';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateGroupSchema } from '@/lib/groups';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** One group, with how many members and leads it has. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getGroup(service, caller, (await params).id));
}

/** Renames a group or changes its slug, description or external_id (an Owner or groups.manage). */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, updateGroupSchema);
    return (await updateGroup(service, caller, (await params).id, body)).group;
  });
}

/** Moves a group to Trash: it stops being a target; who was in it is kept (an Owner or groups.manage). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => trashGroup(service, caller, (await params).id));
}
