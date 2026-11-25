import { runTemplate } from '@/lib/api/task-templates';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { runTaskTemplateSchema } from '@/lib/task-templates';

/** A full-size playbook (200 tasks) is a few seconds; this is the ceiling, as for the MCP server. */
export const maxDuration = 60;

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Uses a template as the signed-in member: every task created at once in
 * the project, then the run recorded. Answers { run, tasks, notes }.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, runTaskTemplateSchema);
    return runTemplate(service, caller, (await params).id, body, 'app');
  }, { status: 201 });
}
