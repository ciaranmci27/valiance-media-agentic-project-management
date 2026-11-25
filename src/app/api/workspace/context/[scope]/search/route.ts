import { scopeFromRequest, searchOneScope } from '@/lib/api/context-scopes';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Entries of one scope matching q, best first (words, "phrases", -not):
 * { entries: [...with rank] }, at most limit (default 20, up to 50). For
 * whoever reads the scope.
 */
export async function GET(request: Request, { params }: { params: Promise<{ scope: string }> }) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const ref = scopeFromRequest(request, (await params).scope);
    const searchParams = new URL(request.url).searchParams;
    const limit = Number(searchParams.get('limit') ?? 20) || 20;
    // Only this scope is searched, after the reader is checked (403 otherwise).
    return { entries: await searchOneScope(service, caller, ref, searchParams.get('q') ?? '', limit) };
  }, { noStore: true });
}
