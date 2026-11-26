import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { markMessageHandled } from '@/lib/chat/messages';

/**
 * Deprecated: the same path under /api/v1/chat/messages also serves company
 * agents. Kept, unchanged, for personal assistants.
 *
 * Marks a chat message routed to the calling assistant handled without a
 * reply, so the pending list stops showing it. Repeating it changes nothing.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Only a personal agent.
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId, principalId }) => {
  requireAgentsEnabled(access);
  return success(await markMessageHandled(supabase, { memberId: teamMemberId, access, principalId, personalOnly: true }, params.id));
}, { optionalBody: true, permission: 'notifications.manage_own' });
