import { removeGroupMember, setGroupMemberRole } from '@/lib/api/groups';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateGroupMemberSchema } from '@/lib/groups';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; memberId: string }> };

/** Makes a member a lead, or a plain member again. */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, memberId } = await params;
    const body = await readWorkspaceBody(request, updateGroupMemberSchema);
    return setGroupMemberRole(service, caller, id, memberId, body.role);
  });
}

/** Takes a member out of the group. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, memberId } = await params;
    return removeGroupMember(service, caller, id, memberId);
  });
}
