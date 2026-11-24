import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { applyAgentTemplate } from '@/lib/api/agent-config';
import { agentTemplateEndpoint } from '@/lib/api/agent-context';
import { logAudit } from '@/lib/api/audit';
import { applyAgentTemplateSchema, type ApplyAgentTemplate } from '@/lib/schemas';

/**
 * Applies an agent template (GET /api/v1/agent-templates) to an agent: its
 * rules, and with create_key a key carrying its scopes. The key applying it
 * must be able to grant every one of the template's scopes (403
 * scope_escalation otherwise, before anything changes); a key is made only
 * as POST /api/v1/api-keys would (an Owner's key, api_keys.manage_all, every
 * scope held by the agent). The key's secret is in this answer only, so the
 * Idempotency-Key header is refused. The template is recorded in the audit
 * log, which is how the agent's context pack and export know it.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const POST = withApi<ApplyAgentTemplate, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const result = await applyAgentTemplate(supabase, { memberId: teamMemberId, access, scopes }, params.id, body, apiKeyId);
  const { secret: _secret, ...keyShown } = result.key as { secret?: string };
  void _secret;
  logAudit(supabase, {
    method: 'POST', endpoint: agentTemplateEndpoint(params.id), entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId,
    requestBody: body, afterSnapshot: { ...result, key: keyShown }, statusCode: 200,
  });
  return NextResponse.json({ success: true, data: result }, { headers: { 'Cache-Control': 'no-store' } });
}, { schema: applyAgentTemplateSchema, permission: 'team.manage', returnsSecret: true });
