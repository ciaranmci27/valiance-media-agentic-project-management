import { listPersonalAgents } from '@/lib/api/personal-agents';
import { pageFrom, pageMeta, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Everyone's personal agents, by name, paged (limit up to 200): each with
 * its person, template, status (paused_with_person when its person's
 * suspension paused it) and live keys (never a secret). needs_key=true lists
 * only active ones with no live key; person_id narrows to one person. Owner
 * only, with AI agents on. Answers { assistants, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 100);
    const { rows, total } = await listPersonalAgents(service, caller, {
      needsKey: searchParams.get('needs_key') === 'true', personId: searchParams.get('person_id'), offset, limit,
    });
    return { assistants: rows, meta: pageMeta(page, limit, total) };
  });
}
