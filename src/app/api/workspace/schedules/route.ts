import { listSchedules, scheduleFiltersFrom, schedulerReady } from '@/lib/api/schedules';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Schedules the signed-in member can see (template schedules and task
 * repeats), soonest next first, a page of up to 200. Answers
 * { schedules, total, scheduler_ready }: scheduler_ready false means the
 * database cannot wake the app yet, so nothing runs on its own.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const params = new URL(request.url).searchParams;
    const offset = Math.max(0, Number(params.get('offset')) || 0);
    const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 200));
    const [{ rows, total }, ready] = await Promise.all([
      listSchedules(service, caller, { ...scheduleFiltersFrom(params), offset, limit }),
      schedulerReady(service),
    ]);
    return { schedules: rows, total, scheduler_ready: ready };
  });
}
