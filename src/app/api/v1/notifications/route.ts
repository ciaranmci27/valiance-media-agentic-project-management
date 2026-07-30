import { randomUUID } from 'crypto';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { badRequest } from '@/lib/api/errors';
import { createNotificationSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { logAudit } from '@/lib/api/audit';
import { z } from 'zod';

export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const { page, limit, offset } = parsePagination(searchParams);
  const isRead = searchParams.get('is_read');
  const entityType = searchParams.get('entity_type');

  let query = supabase
    .from('team_member_notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', teamMemberId);

  if (isRead === 'true') query = query.eq('is_read', true);
  else if (isRead === 'false') query = query.eq('is_read', false);

  if (entityType) query = query.eq('entity_type', entityType);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

// Agent-to-owner channel: blocking questions and escalations land in the
// in-app inbox. Recipients are resolved server-side by role; the caller can
// never target an arbitrary member.
export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();
  const notification = body as z.infer<typeof createNotificationSchema>;
  const roles = notification.audience === 'owner_and_admins' ? ['owner', 'admin'] : ['owner'];

  const { data: recipients, error: recipientsError } = await supabase
    .from('team_members')
    .select('id')
    .in('role', roles)
    .eq('status', 'active');
  if (recipientsError) throw recipientsError;

  // A fresh UUID per call keeps the unread-dedup index from collapsing
  // distinct questions; passing entity_id (e.g. a comment id) opts into dedup.
  const entityId = notification.entity_id || randomUUID();

  for (const recipient of recipients || []) {
    const { error: notifyError } = await supabase.rpc('upsert_notification', {
      p_user_id: recipient.id,
      p_title: notification.title,
      p_message: notification.message,
      p_link: notification.link || null,
      p_entity_type: notification.entity_type,
      p_entity_id: entityId,
    });
    if (notifyError) throw notifyError;
  }

  const result = { notified: (recipients || []).length, entity_id: entityId };
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/notifications', entityType: notification.entity_type, entityId, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 201 });
  return created(result);
}, { schema: createNotificationSchema, permission: 'notifications.send' });
