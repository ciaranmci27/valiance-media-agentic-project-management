import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { checkWebhookFields, insertServerWebhookEndpoint, listWebhookEndpoints, publicEndpoint } from '@/lib/api/webhook-endpoints';
import { createWebhookEndpointSchema, type CreateWebhookEndpoint } from '@/lib/schemas';
import { updateWebhookEndpoint } from '@/lib/supabase/queries';
import { generateWebhookSecret } from '@/lib/webhooks/sign';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outbound webhook endpoints, as Settings > Developers lists them, without
 * their signing secrets. member_id narrows to endpoints filtered to one
 * member; active=true or false to the ones on or off.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const GET = withApi(async ({ supabase, searchParams }) => {
  const memberId = searchParams.get('member_id');
  if (memberId && !UUID.test(memberId)) throw badRequest('member_id must be a team member id');
  const active = searchParams.get('active');
  return success(await listWebhookEndpoints(supabase, { memberId, active: active === null ? null : active === 'true' }));
}, { permission: 'webhooks.manage' });

/**
 * Adds an endpoint with the rules of the Settings screen: HTTPS (or http on
 * localhost), at least one event, optional project and member filters, and
 * for agent_event.created optional agent_event_types. Its
 * signing secret is generated here and returned in this answer only, so the
 * Idempotency-Key header is refused here.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const POST = withApi<CreateWebhookEndpoint>(async ({ supabase, body, access, apiKeyId, teamMemberId }) => {
  await checkWebhookFields(supabase, access, body);
  const secret = generateWebhookSecret();
  let endpoint = await insertServerWebhookEndpoint(supabase, {
    name: body.name,
    url: body.url,
    secret,
    events: [...new Set(body.events)],
    description: body.description,
    amount_basis: body.amount_basis,
    project_ids: body.project_ids ? [...new Set(body.project_ids)] : null,
    member_id: body.member_id ?? null,
    agent_event_types: body.agent_event_types ?? null,
    created_by: teamMemberId,
  });
  if (body.is_active === false) endpoint = await updateWebhookEndpoint(supabase, endpoint.id, { is_active: false });
  const shown = publicEndpoint(endpoint);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/webhook-endpoints', entityType: 'webhook_endpoint', entityId: shown.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: shown, statusCode: 201 });
  return NextResponse.json({ success: true, data: { endpoint: shown, secret } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: createWebhookEndpointSchema, permission: 'webhooks.manage', returnsSecret: true });
