import { clearTaskRepeat, getTaskRepeat, setTaskRepeat } from '@/lib/api/schedules';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { taskRepeatSchema } from '@/lib/schedules';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** The task's repeat, or null. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getTaskRepeat(service, caller, (await params).id));
}

/** Sets or replaces the task's repeat as the signed-in member. Answers { repeat, due_date, due_date_set }. */
export async function PUT(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, taskRepeatSchema);
    return setTaskRepeat(service, caller, (await params).id, body);
  });
}

/** Stops the task repeating. Copies already made stay. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => clearTaskRepeat(service, caller, (await params).id));
}
