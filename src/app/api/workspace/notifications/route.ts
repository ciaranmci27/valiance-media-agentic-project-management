import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { groupReadSchema, markGroupRead, notificationGroupRows, notificationPage, notificationUnreadCount } from '@/lib/api/notifications';
import { NOTIFICATION_FEED_VIEWS, type NotificationFeedView } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

/**
 * The signed-in member's Updates: view updates (default), unread or done,
 * newest first, a page of up to 100 (before: the previous page's
 * next_cursor). Answers { items, unread, next_cursor }. Notices that announce
 * a Needs you item (receipts), cleared, done and snoozed ones are left out
 * of updates and unread. count=1 answers { unread } alone, for the badge.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    const params = new URL(request.url).searchParams;
    if (params.get('count') === '1') return { unread: await notificationUnreadCount(service, memberId) };
    // One group's rows, as a grouped row expands: { items, next_cursor }.
    const group = params.get('group');
    if (group !== null) return notificationGroupRows(service, memberId, group, { limit: Number(params.get('limit')) || undefined, before: params.get('before') });
    const asked = params.get('view');
    const view: NotificationFeedView = NOTIFICATION_FEED_VIEWS.includes(asked as NotificationFeedView) ? asked as NotificationFeedView : 'updates';
    const limit = Number(params.get('limit')) || undefined;
    return notificationPage(service, memberId, { view, limit, before: params.get('before') });
  }, { noStore: true });
}

/** Marks one group's unread notifications read ({ group_key }), as opening a grouped row does. Answers { marked_read }. */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    const body = await readWorkspaceBody(request, groupReadSchema);
    return markGroupRead(service, memberId, body.group_key);
  });
}
