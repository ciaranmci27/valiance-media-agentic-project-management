import { previewTemplateRun } from '@/lib/api/task-templates';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { runTaskTemplateSchema } from '@/lib/task-templates';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * A dry run as the signed-in member: what a run with this input would make
 * (dated, assigned tasks, dependencies, the initiative) and every reason it
 * would be refused. Writes nothing.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, runTaskTemplateSchema);
    return previewTemplateRun(service, caller, (await params).id, body);
  });
}
