import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateNotificationSchema } from '@/lib/schemas';
import { notFound, badRequest, forbidden } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const id = (params as any).id;
  const { data, error } = await supabase
    .from('team_member_notifications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Notification');
  if (data.user_id !== teamMemberId) throw forbidden('Cannot access notifications belonging to another team member');

  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const id = (params as any).id;
  const { data: before } = await supabase
    .from('team_member_notifications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!before) throw notFound('Notification');
  if (before.user_id !== teamMemberId) throw forbidden('Cannot modify notifications belonging to another team member');

  const { data, error } = await supabase
    .from('team_member_notifications')
    .update(body)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Notification');

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/notifications/${id}`,
    entityType: 'notification',
    entityId: id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success(data);
}, { schema: updateNotificationSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const id = (params as any).id;
  const { data: before } = await supabase
    .from('team_member_notifications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!before) throw notFound('Notification');
  if (before.user_id !== teamMemberId) throw forbidden('Cannot delete notifications belonging to another team member');

  const { error } = await supabase
    .from('team_member_notifications')
    .delete()
    .eq('id', id);

  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/notifications/${id}`,
    entityType: 'notification',
    entityId: id,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });

  return success({ deleted: true });
});
