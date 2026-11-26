import { listOccurrences } from '@/lib/api/schedules';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** What a schedule made, skipped or failed, newest first: the last 20. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { rows, total } = await listOccurrences(service, caller, (await params).id, { offset: 0, limit: 20 });
    return { occurrences: rows, total };
  });
}
