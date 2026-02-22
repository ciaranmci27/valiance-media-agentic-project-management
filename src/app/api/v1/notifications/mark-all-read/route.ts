import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi(async ({ supabase, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

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
});
