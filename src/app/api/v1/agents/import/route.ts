import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { importAgentConfig, importAuditSnapshot } from '@/lib/api/agent-config';
import { AGENT_IMPORT_ENDPOINT } from '@/lib/api/agent-context';
import { logAudit } from '@/lib/api/audit';
import { importAgentConfigSchema, type ImportAgentConfig } from '@/lib/schemas';

/**
 * Creates or updates an agent from an exported configuration document,
 * through the agent setup API's own checks. Without agent_id it adds a new
 * agent (Owner keys only, email required); with agent_id it updates that
 * agent. Projects and the escalation target resolve by id, then by name,
 * among what the caller reaches; anything unmatched is listed in unmatched,
 * and parts the key has no permission for in not_applied. Projects are only
 * added, never removed. Keys are made only with create_keys and new webhook
 * endpoints only with create_webhooks; their secrets are in this answer
 * only, so the Idempotency-Key header is refused. dry_run answers the plan
 * and writes nothing. If it fails partway, what it made that holds a
 * secret is undone and audited, and the answer (500 IMPORT_INCOMPLETE) says
 * what stays (agent-config.ts).
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const POST = withApi<ImportAgentConfig>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const plan = await importAgentConfig(supabase, { memberId: teamMemberId, access, scopes }, body, apiKeyId);
  if (!plan.dry_run && plan.agent.id) {
    logAudit(supabase, {
      method: 'POST', endpoint: AGENT_IMPORT_ENDPOINT, entityType: 'team_member', entityId: plan.agent.id, apiKeyId, teamMemberId,
      requestBody: {
        template: plan.template?.key ?? null, agent_id: body.agent_id ?? null, create_keys: body.create_keys ?? false,
        create_webhooks: body.create_webhooks ?? false, document_version: body.document.version,
      },
      afterSnapshot: importAuditSnapshot(plan),
      statusCode: plan.agent.action === 'create' ? 201 : 200,
    });
  }
  const status = !plan.dry_run && plan.agent.action === 'create' ? 201 : 200;
  return NextResponse.json({ success: true, data: plan }, { status, headers: { 'Cache-Control': 'no-store' } });
}, { schema: importAgentConfigSchema, permission: 'team.manage', returnsSecret: true });
