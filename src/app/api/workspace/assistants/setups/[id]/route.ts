import { deleteAssistantSetup, updateAssistantSetup } from '@/lib/api/personal-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateAssistantSetupSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Changes a setup's template, settings or whether it is on (what it matches never changes). Owner only. */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, updateAssistantSetupSchema);
    return updateAssistantSetup(service, caller, id, body);
  });
}

/** Removes a setup. Agents it made stay with their people. Owner only. */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, caller }) => deleteAssistantSetup(service, caller, id));
}
