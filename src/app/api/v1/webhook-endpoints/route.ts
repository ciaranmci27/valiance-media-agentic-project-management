import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { checkWebhookFields, insertServerWebhookEndpoint, listWebhookEndpoints, publicEndpoint } from '@/lib/api/webhook-endpoints';
import { createWebhookEndpointSchema, type CreateWebhookEndpoint } from '@/lib/schemas';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import { hostInUse, hostOf, recordSetupConfirm } from '@/lib/api/ai-setup-guard';
import { currentAiSetup } from '@/lib/api/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outbound webhook endpoints, as Settings > Developers lists them, without
 * their signing secrets. member_id narrows to endpoints filtered to one
 * member; assistant_setup_id to those scoped to one assistant setup;
 * active=true or false to the ones on or off.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const GET = withApi(async ({ supabase, searchParams }) => {
  const memberId = searchParams.get('member_id');
  if (memberId && !UUID.test(memberId)) throw badRequest('member_id must be a team member id');
  const assistantSetupId = searchParams.get('assistant_setup_id');
  if (assistantSetupId && !UUID.test(assistantSetupId)) throw badRequest('assistant_setup_id must be an assistant setup id');
  const active = searchParams.get('active');
  return success(await listWebhookEndpoints(supabase, { memberId, assistantSetupId, active: active === null ? null : active === 'true' }));
}, { permission: 'webhooks.manage' });

/**
 * Adds an endpoint with the rules of the Settings screen: HTTPS to a public
 * address, at least one event, optional project and member filters, and
 * for agent_event.created optional agent_event_types. assistant_setup_id
 * (instead of member_id) scopes it to every personal agent that assistant
 * setup made, assistant.message included: an Owner's key, or the assistant
 * host's key with assistants.provision. Its
 * signing secret is generated here and returned in this answer only, so the
 * Idempotency-Key header is refused here. In an AI setup session, a
 * webhook to an address no live webhook uses yet is made switched off and
 * waits for the Owner's Allow on the setup screen (needs_owner_confirm in
 * the answer).
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const POST = withApi<CreateWebhookEndpoint>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  await checkWebhookFields(supabase, access, body, undefined, scopes);
  const secret = generateWebhookSecret();
  // In an AI setup session, an address no live webhook uses yet is made switched
  // off and waits for the Owner's Allow: decided before the insert, so it is never live.
  const host = currentAiSetup() ? hostOf(body.url) : null;
  const newHost = host !== null && !(await hostInUse(supabase, host));
  const endpoint = await insertServerWebhookEndpoint(supabase, {
    name: body.name,
    url: body.url,
    secret,
    events: [...new Set(body.events)],
    description: body.description,
    amount_basis: body.amount_basis,
    project_ids: body.project_ids ? [...new Set(body.project_ids)] : null,
    member_id: body.member_id ?? null,
    assistant_setup_id: body.assistant_setup_id ?? null,
    agent_event_types: body.agent_event_types ?? null,
    created_by: teamMemberId,
    ...(newHost || body.is_active === false ? { is_active: false } : {}),
  });
  const waits = newHost ? await recordSetupConfirm(supabase, { kind: 'webhook', agentId: body.member_id ?? null, webhookEndpointId: endpoint.id, host }) : null;
  const shown = publicEndpoint(endpoint);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/webhook-endpoints', entityType: 'webhook_endpoint', entityId: shown.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: shown, statusCode: 201 });
  return NextResponse.json({ success: true, data: { endpoint: shown, secret, ...(waits ? { needs_owner_confirm: waits } : {}) } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: createWebhookEndpointSchema, permission: 'webhooks.manage', returnsSecret: true });
