import { workspaceRoute } from '@/lib/api/workspace-route';
import { notificationGroups } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/**
 * The signed-in member's Updates grouped by what they are about: each
 * group's latest notification with group_count and unread_count, newest
 * group first, keyset paged (before: the previous page's next_cursor).
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => {
    const params = new URL(request.url).searchParams;
    return notificationGroups(service, memberId, { limit: Number(params.get('limit')) || undefined, before: params.get('before') });
  }, { noStore: true });
}
