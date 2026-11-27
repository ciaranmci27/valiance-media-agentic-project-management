import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { personalKeyLifetimeDays, setPersonalKeyLifetimeDays } from '@/lib/api/key-lifetime';
import { auditSettingsForKey } from '@/lib/api/workspace-settings';
import { personalKeySettingsSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * How long a person's new key lasts unless they choose otherwise, and for
 * anyone but an Owner the longest they may choose (Settings > Developers;
 * personal_key_lifetime_days, 1 to 3650, null: until revoked, no limit, the
 * default). Every member reads it, as the New key dialog does; only an
 * Owner changes it, on a key that carries settings.manage. Keys made before
 * keep their own expiry. Answers { personal_key_lifetime_days }.
 */
export const GET = withApi(async ({ supabase }) => {
  return success({ personal_key_lifetime_days: await personalKeyLifetimeDays(supabase) });
}, { permission: 'tasks.read' });

export const PATCH = withApi<{ personal_key_lifetime_days: number | null }>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes key settings');
  const before = await personalKeyLifetimeDays(supabase);
  const days = await setPersonalKeyLifetimeDays(supabase, body.personal_key_lifetime_days);
  auditSettingsForKey(supabase, '/api/v1/workspace/key-settings/personal', { apiKeyId, teamMemberId }, {
    method: 'PATCH', entity_type: 'workspace_key_settings', request_body: body,
    before_snapshot: { personal_key_lifetime_days: before }, after_snapshot: { personal_key_lifetime_days: days },
  });
  return success({ personal_key_lifetime_days: days });
}, { permission: 'settings.manage', schema: personalKeySettingsSchema });
