import { draftTemplateRun } from '@/lib/api/template-drafts';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { draftTemplateRunSchema } from '@/lib/task-templates';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Proposes a run for someone else to approve, as the signed-in member. Answers the draft with its preview. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, draftTemplateRunSchema);
    return (await draftTemplateRun(service, caller, (await params).id, body)).draft;
  }, { status: 201 });
}
