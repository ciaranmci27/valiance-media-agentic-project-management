import { createInitiative, initiativeFiltersFrom, listInitiatives } from '@/lib/api/initiatives';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createInitiativeSchema } from '@/lib/initiatives';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The project's initiatives the signed-in member reads, in order, paged
 * (limit up to 200). Done ones only with include_done=true. Answers
 * { initiatives, meta }.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 200);
    const { rows, total } = await listInitiatives(service, caller, (await params).id, { ...initiativeFiltersFrom(searchParams), offset, limit });
    return { initiatives: rows, meta: pageMeta(page, limit, total) };
  });
}

/** Creates an initiative in the project (tasks.create there). */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, createInitiativeSchema);
    return createInitiative(service, caller, (await params).id, body);
  }, { status: 201 });
}
