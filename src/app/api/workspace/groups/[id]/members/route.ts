import { addGroupMembers, groupMemberFiltersFrom, listGroupMembers } from '@/lib/api/groups';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { addGroupMembersSchema } from '@/lib/groups';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** A group's members, leads first, paged (limit up to 100). Filters: search (name), role. Answers { members, meta }. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 100, 50);
    const { rows, total } = await listGroupMembers(service, caller, (await params).id, { ...groupMemberFiltersFrom(searchParams), offset, limit });
    return { members: rows, meta: pageMeta(page, limit, total) };
  });
}

/** Adds members (up to 500 at once) as member or lead; one already in it takes the role sent. Answers { added, updated }. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, addGroupMembersSchema);
    return addGroupMembers(service, caller, (await params).id, body);
  });
}
