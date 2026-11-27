import type { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { listSnoozes, snoozeItem, snoozeSchema } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/** The key's own member's snoozes still in force, soonest to wake first: { item_kind, item_id, until }. */
export const GET = withApi(async ({ supabase, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');
  return success(await listSnoozes(supabase, teamMemberId));
}, { permission: 'notifications.manage_own' });

/**
 * Snoozes one item for the key's own member: { item_kind (question, task,
 * suggestion or notification), item_id, until } (in the future, at most 90
 * days away). It is hidden from their Needs you or Updates until then;
 * snoozing it again moves the time. Answers the snooze.
 */
export const POST = withApi<z.infer<typeof snoozeSchema>>(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');
  const snooze = await snoozeItem(supabase, teamMemberId, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/notifications/snoozes', entityType: body.item_kind, entityId: body.item_id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: snooze, statusCode: 200 });
  return success(snooze);
}, { schema: snoozeSchema, permission: 'notifications.manage_own' });
