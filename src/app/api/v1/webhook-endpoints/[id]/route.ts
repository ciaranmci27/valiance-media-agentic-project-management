import type { SupabaseClient } from '@supabase/supabase-js';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { checkWebhookFields, publicEndpoint } from '@/lib/api/webhook-endpoints';
import { updateWebhookEndpointSchema, type UpdateWebhookEndpoint } from '@/lib/schemas';
import { deleteWebhookEndpoint, updateWebhookEndpoint } from '@/lib/supabase/queries';
import type { WebhookEndpoint } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadEndpoint(supabase: SupabaseClient, id: string): Promise<WebhookEndpoint> {
  if (!UUID.test(id)) throw notFound('Webhook endpoint');
  const { data, error } = await supabase.from('webhook_endpoints').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Webhook endpoint');
  return data as WebhookEndpoint;
}

/**
 * Changes an endpoint: name, url, events, description, amount_basis, the
 * project and member filters, or is_active (false pauses deliveries). Send
 * only what changes. The signing secret never changes and is never shown.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const PATCH = withApi<UpdateWebhookEndpoint, { id: string }>(async ({ supabase, params, body, access, apiKeyId, teamMemberId }) => {
  const before = await loadEndpoint(supabase, params.id);
  await checkWebhookFields(supabase, access, body, before);
  const patch = {
    ...body,
    ...(body.events ? { events: [...new Set(body.events)] } : {}),
    ...(body.project_ids ? { project_ids: [...new Set(body.project_ids)] } : {}),
  };
  const shown = publicEndpoint(await updateWebhookEndpoint(supabase, params.id, patch));
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/webhook-endpoints/${params.id}`, entityType: 'webhook_endpoint', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: publicEndpoint(before), afterSnapshot: shown, statusCode: 200 });
  return success(shown);
}, { schema: updateWebhookEndpointSchema, permission: 'webhooks.manage' });

/**
 * Deletes an endpoint, as Settings > Developers does: events stop going to
 * its URL and its delivery history goes with it. To pause it instead, PATCH
 * is_active false.
 *
 * Permission: webhooks.manage (the Webhooks module).
 */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const before = await loadEndpoint(supabase, params.id);
  await deleteWebhookEndpoint(supabase, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/webhook-endpoints/${params.id}`, entityType: 'webhook_endpoint', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: publicEndpoint(before), statusCode: 200 });
  return success({ deleted: true });
}, { permission: 'webhooks.manage' });
