import type { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { doneSchema, setNotificationsDone } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/**
 * Marks the key's own member's notifications done ({ ids, done: true }, done
 * implies read), not done again ({ ids, done: false }), or every open
 * Update done ({ all: true }), as the Notifications page does. Receipts (a
 * question or approval waiting in Needs you) are left as they are by all.
 * Answers { updated }. 503 database_update_needed before 20261127000700.
 */
export const POST = withApi<z.infer<typeof doneSchema>>(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');
  const result = await setNotificationsDone(supabase, teamMemberId, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/notifications/done', entityType: 'notification', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { schema: doneSchema, permission: 'notifications.manage_own' });
