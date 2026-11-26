import { deleteSchedule, getSchedule, updateSchedule } from '@/lib/api/schedules';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { scheduleUpdateSchema } from '@/lib/schedules';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getSchedule(service, caller, (await params).id));
}

/** Changes, pauses (status paused) or resumes (status active) a schedule as the signed-in member. */
export async function PATCH(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, scheduleUpdateSchema);
    return updateSchedule(service, caller, (await params).id, body);
  });
}

/** Removes a schedule: it never runs again; what it made stays. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => deleteSchedule(service, caller, (await params).id));
}
