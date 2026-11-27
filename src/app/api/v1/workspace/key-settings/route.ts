import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { agentKeyLifetimeDays, setAgentKeyLifetimeDays } from '@/lib/api/key-lifetime';
import { auditSettingsForKey } from '@/lib/api/workspace-settings';
import { keySettingsSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * How long a new agent key lasts (Settings > Developers; agent_key_lifetime_days,
 * 1 to 3650, null: until revoked, the default). Keys made before keep their
 * own expiry. Owner only, by role, on a key that carries settings.manage.
 * Answers { agent_key_lifetime_days }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees key settings');
  return success({ agent_key_lifetime_days: await agentKeyLifetimeDays(supabase) });
}, { permission: 'settings.manage' });

export const PATCH = withApi<{ agent_key_lifetime_days: number | null }>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes key settings');
  const before = await agentKeyLifetimeDays(supabase);
  const days = await setAgentKeyLifetimeDays(supabase, body.agent_key_lifetime_days);
  auditSettingsForKey(supabase, '/api/v1/workspace/key-settings', { apiKeyId, teamMemberId }, {
    method: 'PATCH', entity_type: 'workspace_key_settings', request_body: body,
    before_snapshot: { agent_key_lifetime_days: before }, after_snapshot: { agent_key_lifetime_days: days },
  });
  return success({ agent_key_lifetime_days: days });
}, { permission: 'settings.manage', schema: keySettingsSchema });
