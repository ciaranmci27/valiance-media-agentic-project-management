import { listRuns } from '@/lib/api/task-templates';
import { pageFrom, pageMeta, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** A template's runs, newest first, paged (limit up to 100). Answers { runs, meta }. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { page, limit, offset } = pageFrom(new URL(request.url).searchParams, 100, 10);
    const { rows, total } = await listRuns(service, caller, (await params).id, { offset, limit });
    return { runs: rows, meta: pageMeta(page, limit, total) };
  });
}
