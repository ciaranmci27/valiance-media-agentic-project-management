import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { doneSchema, setNotificationsDone } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/**
 * Marks the signed-in member's notifications done ({ ids, done: true },
 * done implies read), not done again ({ ids, done: false }), or every open
 * Update done ({ all: true }). Answers { updated }.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => setNotificationsDone(service, memberId, await readWorkspaceBody(request, doneSchema)));
}
