import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { assistantStatusList } from '@/lib/api/assistant';

export const dynamic = 'force-dynamic';

/**
 * Every person's assistant with its state (working, paused by its person,
 * on hold, getting ready, broken and why, host_down), broken ones first, as
 * Settings > Assistants > Status shows it. Answers { assistants }. An
 * Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, "sees everyone's assistants");
  return success({ assistants: await assistantStatusList(supabase, access) });
}, { permission: 'team.manage' });
