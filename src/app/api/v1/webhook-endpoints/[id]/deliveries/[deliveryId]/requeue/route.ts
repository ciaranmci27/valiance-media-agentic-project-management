import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requeueEndpointDelivery } from '@/lib/api/webhook-endpoints';

export const dynamic = 'force-dynamic';

/**
 * Resends a failed delivery, as Resend in Settings > Developers does: it
 * goes back to pending with a fresh attempt budget and is sent right after
 * this answer. 404 when the delivery is not this endpoint's; 409 not_failed
 * (with its status) when it is waiting, sending or already delivered.
 * Answers the delivery as it is now.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const POST = withApi<unknown, { id: string; deliveryId: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const delivery = await requeueEndpointDelivery(supabase, params.id, params.deliveryId);
  logAudit(supabase, {
    method: 'POST', endpoint: `/api/v1/webhook-endpoints/${params.id}/deliveries/${params.deliveryId}/requeue`,
    entityType: 'webhook_delivery', entityId: params.deliveryId, apiKeyId, teamMemberId,
    afterSnapshot: { status: delivery.status, attempts: delivery.attempts }, statusCode: 200,
  });
  return success(delivery);
}, { permission: 'webhooks.manage' });
