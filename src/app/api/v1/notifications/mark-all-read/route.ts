import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { z } from 'zod';
import { GROUP_KEY } from '@/lib/notifications';
import { markGroupRead } from '@/lib/api/notifications';

/** No body, as before (every unread notification); or { group_key } for one group. Other keys are ignored, as they always were. */
const markAllReadSchema = z.object({
  group_key: z.string().regex(GROUP_KEY, 'group_key must be a group_key from list_notification_groups').optional(),
});

export const POST = withApi<z.infer<typeof markAllReadSchema>>(async ({ supabase, apiKeyId, teamMemberId, body }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  // With group_key: only that group's unread notifications, as opening a grouped row in the app.
  const groupKey = body?.group_key;
  if (groupKey !== undefined) {
    const result = await markGroupRead(supabase, teamMemberId, groupKey);
    logAudit(supabase, { method: 'POST', endpoint: '/api/v1/notifications/mark-all-read', entityType: 'notification', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 200 });
    return success(result);
  }

  const { data, error } = await supabase
    .from('team_member_notifications')
    .update({ is_read: true })
    .eq('user_id', teamMemberId)
    .eq('is_read', false)
    .select('id');

  if (error) throw error;

  const count = data?.length || 0;

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/notifications/mark-all-read',
    entityType: 'notification',
    apiKeyId,
    teamMemberId,
    afterSnapshot: { marked_read: count },
    statusCode: 200,
  });

  return success({ marked_read: count });
}, { schema: markAllReadSchema, optionalBody: true, permission: 'notifications.manage_own' });
