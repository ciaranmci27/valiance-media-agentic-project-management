import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { agentTemplateView } from '@/lib/agent-templates';
import { createTemplateRow, listAgentTemplatesFor, templateRowInputSchema, type TemplateRowInput } from '@/lib/api/agent-registries';
import { logAudit } from '@/lib/api/audit';
import { created } from '@/lib/api/response';

/**
 * The agent templates this install offers: core's, its own from
 * src/custom/agent-templates.ts, then an Owner's own (rows, POST here). Each has a key, label, description, the
 * rules it sets, the scopes a key for it should carry, the brief added to
 * the agent's context pack, suggested webhook events, the settings it asks
 * for on each project, and the role and profile an agent from it starts with. A template whose
 * module is off is not listed. Apply one with POST /api/v1/agents/{id}/template.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access }) => {
  requireAgentsEnabled(access);
  return success((await listAgentTemplatesFor(supabase, access)).map(agentTemplateView));
}, { permission: 'team.manage' });

/**
 * Adds an Owner's own template (a row): key, label, description, rules,
 * scopes, context, and optionally webhook_events, module, settings, role,
 * profile and limits, checked exactly as code's are. A key code holds is
 * 409 registry_key_taken; one a row holds is 409 registry_key_exists.
 *
 * Permission: team.manage, Owner only, with the AI agents module on.
 */
export const POST = withApi<TemplateRowInput>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await createTemplateRow(supabase, { memberId: teamMemberId, access }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agent-templates', entityType: 'agent_template', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: row, statusCode: 201 });
  return created(row);
}, { schema: templateRowInputSchema, permission: 'team.manage' });
