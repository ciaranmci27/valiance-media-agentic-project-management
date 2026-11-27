import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { logAudit } from '@/lib/api/audit';
import { rotateWebhookSecret } from '@/lib/api/webhook-endpoints';

export const dynamic = 'force-dynamic';

/**
 * A new signing secret for the endpoint (New signing secret in Settings >
 * Developers), for when the old one may have leaked: the endpoint keeps its
 * id, filters and delivery history, and the old secret stops at once.
 * Answers { secret } (whsec_...), shown only in this answer, as on create,
 * so the Idempotency-Key header is refused here. An existing secret is never
 * read or answered over the API: reveal stays in the app.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const secret = await rotateWebhookSecret(supabase, params.id);
  logAudit(supabase, {
    method: 'POST', endpoint: `/api/v1/webhook-endpoints/${params.id}/secret`, entityType: 'webhook_endpoint',
    entityId: params.id, apiKeyId, teamMemberId, afterSnapshot: { secret_rotated: true }, statusCode: 200,
  });
  return NextResponse.json({ success: true, data: { secret } }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'webhooks.manage', returnsSecret: true });
