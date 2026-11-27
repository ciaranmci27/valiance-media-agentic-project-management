import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { readAssistantSettings, updateAssistantSettings } from '@/lib/api/assistant';
import { assistantSettingsSchema } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

type SettingsBody = { enabled?: boolean; label?: string | null };

/**
 * Whether assistants are on and what the workspace calls them, as Settings >
 * Assistants shows it: { enabled, label, custom_label } (custom_label null
 * when the workspace uses the default name). An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'manages assistants');
  return success(await readAssistantSettings(supabase));
}, { permission: 'team.manage' });

/**
 * Turns assistants on or off (enabled) and names them (label; null for the
 * default), as Settings > Assistants does. While off, every personal agent's
 * key is refused (423 assistants_off). Answers the settings again.
 *
 * Permission: team.manage, by an Owner.
 */
export const PATCH = withApi<SettingsBody>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'turns assistants on or names them');
  return success(await updateAssistantSettings(supabase, access, teamMemberId, body, { endpoint: '/api/v1/assistants/settings', apiKeyId }));
}, { schema: assistantSettingsSchema, permission: 'team.manage' });
