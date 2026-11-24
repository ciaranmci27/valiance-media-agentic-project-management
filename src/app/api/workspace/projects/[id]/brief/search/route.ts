import { searchBrief } from '@/lib/api/project-brief';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Brief entries matching q, best first, over the full-text index (words,
 * "phrases", -not): { entries: [...with rank] }, at most limit (default 20,
 * up to 50). For project_context.read on a project the caller reaches.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const limit = Number(searchParams.get('limit') ?? 20) || 20;
    return { entries: await searchBrief(service, caller, (await params).id, searchParams.get('q') ?? '', limit) };
  });
}
