import { z } from 'zod';
import { validateTemplate } from '@/lib/api/task-templates';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  template: z.record(z.string(), z.unknown()),
  template_id: z.uuid('template_id must be a uuid').optional(),
}).strict();

/**
 * Checks a template without saving it, as the signed-in member: { valid,
 * errors, template, can_save }. With template_id, template is a change to it.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, bodySchema);
    return validateTemplate(service, caller, body.template, body.template_id ?? null);
  });
}
