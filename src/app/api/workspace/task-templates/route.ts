import { createTemplate, listTemplates, templateFiltersFrom } from '@/lib/api/task-templates';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createTaskTemplateSchema } from '@/lib/task-templates';

export const dynamic = 'force-dynamic';

/**
 * The task templates the signed-in member may read, by name, paged (limit up
 * to 200), without their tasks. Filters: search (name), project_id (only
 * those usable there). Answers { templates, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 50);
    const { rows, total } = await listTemplates(service, caller, { ...templateFiltersFrom(searchParams), offset, limit });
    return { templates: rows, meta: pageMeta(page, limit, total) };
  });
}

/** Creates a template (templates.manage). */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, createTaskTemplateSchema);
    return createTemplate(service, caller, body);
  }, { status: 201 });
}
