import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { auditSettings, setAuditSettings } from '@/lib/api/workspace-controls';
import { auditSettingsForKey } from '@/lib/api/workspace-settings';
import { auditSettingsSchema, type AuditSettingsPatch } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * The audit log's settings (Settings > Security, Keeping the log) over the
 * API: how long it keeps rows (retention_days, 30 to 3650; null keeps them
 * forever) and the workspace's own field names to redact beside the built-in
 * list (redact_keys). Owner only, by role, on a key that carries
 * settings.manage; a change is itself audited. Answers
 * { retention_days, redact_keys }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees audit settings');
  return success(await auditSettings(supabase));
}, { permission: 'settings.manage' });

export const PUT = withApi<AuditSettingsPatch>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes audit settings');
  const before = await auditSettings(supabase);
  const after = await setAuditSettings(supabase, body);
  auditSettingsForKey(supabase, '/api/v1/workspace/audit-settings', { apiKeyId, teamMemberId },
    { method: 'PUT', entity_type: 'business_settings', request_body: body, before_snapshot: before, after_snapshot: after });
  return success(after);
}, { permission: 'settings.manage', schema: auditSettingsSchema });
