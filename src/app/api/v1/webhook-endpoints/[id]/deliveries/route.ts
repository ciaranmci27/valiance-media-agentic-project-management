import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { listWebhookDeliveries } from '@/lib/api/webhook-endpoints';
import { WEBHOOK_DELIVERY_STATUSES, type WebhookDeliveryStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * One endpoint's deliveries, newest first, as Settings > Developers shows
 * them under Recent deliveries: status (pending, delivering, succeeded,
 * failed), attempts, next_attempt_at, the receiver's last status code,
 * error and response, delivered_at, and the event each carries
 * (webhook_events: event_id, event_type, created_at). Never a signing
 * secret. status narrows to one state; limit 1-100, default 25.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams }) => {
  const status = searchParams.get('status');
  if (status !== null && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of: ${WEBHOOK_DELIVERY_STATUSES.join(', ')}`, { reason: 'invalid_status' });
  }
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10) || 25));
  return success(await listWebhookDeliveries(supabase, params.id, { status: status as WebhookDeliveryStatus | null, limit }));
}, { permission: 'webhooks.manage' });
