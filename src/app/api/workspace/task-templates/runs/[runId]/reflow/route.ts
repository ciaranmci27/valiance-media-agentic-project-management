import { reflowTemplateRun } from '@/lib/api/template-reflow';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { reflowTemplateRunSchema } from '@/lib/task-templates';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * Changes a live run's key dates as the signed-in member (dry_run true for
 * the preview): untouched tasks move, hand-changed ones come back as kept
 * unless include_task_ids names them, the initiative's target follows.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, reflowTemplateRunSchema);
    return reflowTemplateRun(service, caller, (await params).runId, body);
  });
}
