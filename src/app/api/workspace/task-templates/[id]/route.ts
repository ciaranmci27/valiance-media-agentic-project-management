import { getTemplate, trashTemplate, updateTemplate } from '@/lib/api/task-templates';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** One template with its tasks. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getTemplate(service, caller, (await params).id));
}

/** Changes a template: only what is sent; arrays replaced whole (as for creating it, in its scope). */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, z.record(z.string(), z.unknown()));
    return (await updateTemplate(service, caller, (await params).id, body)).template;
  });
}

/** Moves a template to Trash; the tasks it made and its runs stay (as for changing it). */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => trashTemplate(service, caller, (await params).id));
}
