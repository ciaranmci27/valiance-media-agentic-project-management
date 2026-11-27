import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { unsnoozeItem, unsnoozeSchema } from '@/lib/api/notifications';
import { SNOOZE_KINDS } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

/**
 * Brings one of the key's own member's snoozed items back now (kind:
 * question, task, suggestion or notification). Answers { removed }: false
 * when it was not snoozed.
 */
export const DELETE = withApi<unknown, { kind: string; itemId: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');
  const parsed = unsnoozeSchema.safeParse({ item_kind: params.kind, item_id: params.itemId });
  if (!parsed.success) throw badRequest(`kind must be one of: ${SNOOZE_KINDS.join(', ')}; itemId a uuid`, { reason: 'invalid_item' });
  const result = await unsnoozeItem(supabase, teamMemberId, parsed.data);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/notifications/snoozes/${parsed.data.item_kind}/${parsed.data.item_id}`, entityType: parsed.data.item_kind, entityId: parsed.data.item_id, apiKeyId, teamMemberId, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { permission: 'notifications.manage_own' });
