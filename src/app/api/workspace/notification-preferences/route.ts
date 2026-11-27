import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { notificationPreferencesPatchSchema, readNotificationPreferences, updateNotificationPreferences } from '@/lib/api/notification-preferences';

export const dynamic = 'force-dynamic';

/** Settings > Notifications for the signed-in member: the same answer as GET /api/v1/me/notification-preferences. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => readNotificationPreferences(service, memberId), { noStore: true });
}

/** Changes only the choices sent, as PATCH /api/v1/me/notification-preferences does (one code path). */
export async function PATCH(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    const { after } = await updateNotificationPreferences(service, memberId, await readWorkspaceBody(request, notificationPreferencesPatchSchema));
    return after;
  });
}
