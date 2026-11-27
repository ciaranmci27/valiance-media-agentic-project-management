import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { notificationGroups } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/**
 * The key's own member's Updates grouped by what they are about, as the
 * Notifications page groups them: each group's latest notification with
 * group_key, group_count and unread_count, newest group first (done,
 * receipts and snoozed left out). Keyset paged: before is the previous
 * page's next_cursor; limit 1-100, default 30.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');
  return success(await notificationGroups(supabase, teamMemberId, { limit: Number(searchParams.get('limit')) || undefined, before: searchParams.get('before') }));
}, { permission: 'notifications.manage_own' });
