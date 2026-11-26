import { z } from 'zod';
import { hasPermission } from '@/lib/access-control';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { insertAuditRows } from '@/lib/api/audit';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { checkWebhookFields, insertServerWebhookEndpoint, publicEndpoint } from '@/lib/api/webhook-endpoints';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createWebhookEndpointSchema } from '@/lib/schemas';
import { generateWebhookSecret } from '@/lib/webhooks/sign';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ url: z.string().max(2000), events: z.array(z.string()).min(1).max(50) }).strict();

/**
 * Wakes a new agent's harness: one webhook endpoint filtered to this agent
 * (member_id), for the events its template names, with the rules of
 * Settings > Developers and the v1 API (HTTPS to a public address, known
 * events, the same filter checks). Who manages webhooks (webhooks.manage,
 * the Webhooks module on). Answers { endpoint, secret }: the signing secret,
 * also opened later in Settings > Developers. Never cached.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    requireAgentsEnabled(access);
    if (!hasPermission(access, 'webhooks.manage')) {
      throw forbidden('Setting up a webhook needs Manage webhooks, with the Webhooks module on', { reason: 'missing_permission', needs: 'webhooks.manage' });
    }
    const agentId = (await params).id;
    const input = await readWorkspaceBody(request, bodySchema);
    const { data: agent, error } = await service.from('team_members').select('id, name, role').eq('id', agentId).maybeSingle();
    if (error) throw error;
    if (!agent || (agent as { role: string }).role !== 'agent') throw notFound('Agent');

    const parsed = createWebhookEndpointSchema.safeParse({
      name: `${(agent as { name: string }).name}`.slice(0, 100),
      url: input.url,
      events: input.events,
      description: 'Wakes this agent for its own work.',
      member_id: agentId,
    });
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!(key in fields)) fields[key] = issue.message;
      }
      throw new ApiError(422, 'VALIDATION_ERROR', Object.values(fields)[0] ?? 'Invalid webhook', { reason: 'invalid_body', fields });
    }
    const body = parsed.data;
    await checkWebhookFields(service, access, body);
    const secret = generateWebhookSecret();
    const endpoint = await insertServerWebhookEndpoint(service, {
      name: body.name, url: body.url, secret, events: [...new Set(body.events)], description: body.description,
      member_id: agentId, created_by: memberId,
    });
    const shown = publicEndpoint(endpoint);
    const { error: auditError } = await insertAuditRows(service, {
      method: 'POST', endpoint: `/api/workspace/agents/${agentId}/webhook`, entity_type: 'webhook_endpoint', entity_id: shown.id,
      api_key_id: null, team_member_id: memberId, request_body: body, after_snapshot: shown, status_code: 201, via: 'app',
    });
    if (auditError) console.error('[agents] webhook audit write failed', auditError);
    return { endpoint: shown, secret };
  }, { status: 201, noStore: true });
}
