import { listTemplateDrafts, templateDraftFiltersFrom } from '@/lib/api/template-drafts';
import { pageFrom, pageMeta, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Template run drafts on projects the signed-in member can open, newest
 * first, paged (limit up to 100). Filters: project_id, template_id, status.
 * Answers { drafts, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 100, 25);
    const { rows, total } = await listTemplateDrafts(service, caller, { ...templateDraftFiltersFrom(searchParams), offset, limit });
    return { drafts: rows, meta: pageMeta(page, limit, total) };
  });
}
