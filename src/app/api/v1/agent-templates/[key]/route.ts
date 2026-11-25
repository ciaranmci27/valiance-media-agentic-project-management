import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { templateRowPatchSchema, updateTemplateRow, type TemplateRowPatch } from '@/lib/api/agent-registries';

export const dynamic = 'force-dynamic';

/**
 * Changes an Owner's own template: any of label, description, rules,
 * scopes, context, webhook_events, module, settings, role, profile, limits,
 * checked exactly as code's are; archived true archives it (false brings it
 * back). Agents already set up from it keep their setup. Code's templates
 * are not rows (409 registry_key_taken).
 *
 * Permission: team.manage, Owner only, with the AI agents module on.
 */
export const PATCH = withApi<TemplateRowPatch, { key: string }>(async ({ supabase, params, body, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await updateTemplateRow(supabase, { memberId: teamMemberId, access }, params.key, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/agent-templates/${params.key}`, entityType: 'agent_template', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: row, statusCode: 200 });
  return success(row);
}, { schema: templateRowPatchSchema, permission: 'team.manage' });

/** Archives an Owner's own template (rows are never deleted), as PATCH with archived true. */
export const DELETE = withApi<unknown, { key: string }>(async ({ supabase, params, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await updateTemplateRow(supabase, { memberId: teamMemberId, access }, params.key, { archived: true });
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/agent-templates/${params.key}`, entityType: 'agent_template', apiKeyId, teamMemberId, afterSnapshot: row, statusCode: 200 });
  return success(row);
}, { permission: 'team.manage' });
