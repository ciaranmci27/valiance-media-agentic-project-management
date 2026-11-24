import { listProjectAgents } from '@/lib/api/project-agents';
import { pageFrom, pageMeta, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The agents on a project, newest first, paged (limit up to 200, default
 * 100): { assignments: [{ agent_id, agent_name, avatar_url, agent_role,
 * status, template_key, settings, instructions, settings_schema, created_at,
 * updated_at, project_id, project_name }], meta }. For members who can open
 * the project, with AI agents on. Filters: status, template.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 100);
    const { rows, total } = await listProjectAgents(service, caller, (await params).id, {
      status: searchParams.get('status'), template: searchParams.get('template'), offset, limit,
    });
    return { assignments: rows, meta: pageMeta(page, limit, total) };
  });
}
