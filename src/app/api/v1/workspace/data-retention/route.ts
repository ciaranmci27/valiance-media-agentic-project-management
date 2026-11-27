import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { dataRetentionSettings, setDataRetentionSettings } from '@/lib/api/data-retention';
import { auditSettingsForKey } from '@/lib/api/workspace-settings';
import { dataRetentionSchema, type DataRetentionPatch } from '@/lib/data-retention';

export const dynamic = 'force-dynamic';

/**
 * Keeping data (Settings > Security) over the API: how long webhook
 * deliveries, agent uptime history, agent events, agent runs and chat
 * message text are kept, in days, or null to keep forever. Owner only, by
 * role, on a key that carries settings.manage. PUT changes the settings sent
 * and leaves the rest; a daily job applies them (preview what a shorter one
 * removes with POST /api/v1/workspace/retention-preview first). Answers
 * every setting.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees data retention');
  return success(await dataRetentionSettings(supabase));
}, { permission: 'settings.manage' });

export const PUT = withApi<DataRetentionPatch>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes data retention');
  const before = await dataRetentionSettings(supabase);
  const after = await setDataRetentionSettings(supabase, body);
  auditSettingsForKey(supabase, '/api/v1/workspace/data-retention', { apiKeyId, teamMemberId },
    { method: 'PUT', entity_type: 'business_settings', request_body: body, before_snapshot: before, after_snapshot: after });
  return success(after);
}, { permission: 'settings.manage', schema: dataRetentionSchema });
