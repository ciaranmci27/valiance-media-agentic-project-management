import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import {
  notificationPreferencesPatchSchema, readNotificationPreferences, updateNotificationPreferences, type NotificationPreferencesPatch,
} from '@/lib/api/notification-preferences';

export const dynamic = 'force-dynamic';

/**
 * Settings > Notifications for the key's own member: each category on or off
 * in the app and by email, and the email switch. Only your own: no key reads
 * or changes anyone else's. Answers { in_app, email_enabled, email,
 * email_available }.
 */
export const GET = withApi(async ({ supabase, teamMemberId }) => success(await readNotificationPreferences(supabase, teamMemberId)), { permission: 'notifications.manage_own' });

/** Changes only the categories sent (true on, false off) and the email switch (409 email_not_set_up while the workspace sends no email). */
export const PATCH = withApi<NotificationPreferencesPatch>(async ({ supabase, teamMemberId, apiKeyId, body }) => {
  const { before, after } = await updateNotificationPreferences(supabase, teamMemberId, body);
  logAudit(supabase, { method: 'PATCH', endpoint: '/api/v1/me/notification-preferences', entityType: 'team_member', entityId: teamMemberId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: after, statusCode: 200 });
  return success(after);
}, { schema: notificationPreferencesPatchSchema, permission: 'notifications.manage_own' });
