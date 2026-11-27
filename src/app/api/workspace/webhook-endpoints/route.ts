import { hasPermission } from '@/lib/access-control';
import { insertAuditRows } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { checkWebhookFields, insertServerWebhookEndpoint, publicEndpoint } from '@/lib/api/webhook-endpoints';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createWebhookEndpointSchema } from '@/lib/schemas';
import { updateWebhookEndpoint } from '@/lib/supabase/queries';
import { generateWebhookSecret } from '@/lib/webhooks/sign';

export const dynamic = 'force-dynamic';

/**
 * Adds an endpoint from Settings > Developers, on the server so its signing
 * secret is stored encrypted (APP_ENCRYPTION_KEY; without it, 409
 * encryption_key_missing and nothing is written). The rules are the v1
 * route's (POST /api/v1/webhook-endpoints, MCP create_webhook_endpoint):
 * HTTPS to a public address, known events, the same filter checks. Needs
 * webhooks.manage. Answers { endpoint, secret }: the secret shown once (it
 * can be revealed again from the row). Never cached.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    if (!hasPermission(access, 'webhooks.manage')) {
      throw forbidden('Adding a webhook needs Manage webhooks, with the Webhooks module on', { reason: 'missing_permission', needs: 'webhooks.manage' });
    }
    const body = await readWorkspaceBody(request, createWebhookEndpointSchema);
    await checkWebhookFields(service, access, body);
    const secret = generateWebhookSecret();
    let endpoint = await insertServerWebhookEndpoint(service, {
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
      created_by: memberId,
    });
    if (body.is_active === false) endpoint = await updateWebhookEndpoint(service, endpoint.id, { is_active: false });
    const shown = publicEndpoint(endpoint);
    const { error: auditError } = await insertAuditRows(service, {
      method: 'POST', endpoint: '/api/workspace/webhook-endpoints', entity_type: 'webhook_endpoint', entity_id: shown.id,
      api_key_id: null, team_member_id: memberId, request_body: body, after_snapshot: shown, status_code: 201, via: 'app',
    });
    if (auditError) console.error('[webhooks] endpoint audit write failed', auditError);
    // The stored (sealed) secret stays on the row as Settings reads it; the plaintext is in secret.
    return { endpoint, secret };
  }, { status: 201, noStore: true });
}
