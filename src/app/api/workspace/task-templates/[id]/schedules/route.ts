import { createTemplateSchedule } from '@/lib/api/schedules';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { templateScheduleSchema } from '@/lib/schedules';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Runs the template on a schedule, as the signed-in member: checked like a run for its first date. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, templateScheduleSchema);
    return createTemplateSchedule(service, caller, (await params).id, body);
  }, { status: 201 });
}
