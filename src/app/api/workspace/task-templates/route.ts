import { createTemplate, listTemplates, templateFiltersFrom } from '@/lib/api/task-templates';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * The task templates the signed-in member may read, by name, paged (limit up
 * to 200), without their tasks. Filters: search (name), project_id (only
 * those usable there, its own first), scope (project or workspace). Answers { templates, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 50);
    const { rows, total } = await listTemplates(service, caller, { ...templateFiltersFrom(searchParams), offset, limit });
    return { templates: rows, meta: pageMeta(page, limit, total) };
  });
}

/**
 * Creates a template from the JSON template: company-wide needs
 * templates.manage, a project's needs projects.manage or templates.manage.
 * A refusal lists every error with its path.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, z.record(z.string(), z.unknown()));
    return createTemplate(service, caller, body);
  }, { status: 201 });
}
