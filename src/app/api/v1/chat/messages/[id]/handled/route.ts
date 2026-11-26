import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { markMessageHandled } from '@/lib/chat/messages';

/**
 * Marks a chat request routed to the calling agent handled without a reply,
 * so the pending list stops showing it. Repeating it changes nothing.
 * Context needs no marking (409 not_a_request).
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId, principalId }) => {
  requireAgentsEnabled(access);
  return success(await markMessageHandled(supabase, { memberId: teamMemberId, access, principalId }, params.id));
}, { optionalBody: true, permission: 'notifications.manage_own' });
