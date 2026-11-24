import { createGroup, groupFiltersFrom, listGroups } from '@/lib/api/groups';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createGroupSchema } from '@/lib/groups';

export const dynamic = 'force-dynamic';

/**
 * The groups the signed-in member may read, by name, paged (limit up to
 * 100): every live group for whoever may read the team, else the ones they
 * are in. Filters: search (name or slug), member (me or a member id).
 * Answers { groups, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 100, 50);
    const { rows, total } = await listGroups(service, caller, { ...groupFiltersFrom(searchParams), offset, limit });
    return { groups: rows, meta: pageMeta(page, limit, total) };
  });
}

/** Creates a group, with its first members and leads (an Owner or groups.manage). */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, createGroupSchema);
    return createGroup(service, caller, body);
  }, { status: 201 });
}
