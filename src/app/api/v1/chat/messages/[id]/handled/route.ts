import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { markMessageHandled } from '@/lib/chat/messages';
import { chatHandledSchema, type ChatHandledInput } from '@/lib/chat/types';

/**
 * Marks a chat request routed to the calling agent handled without a reply,
 * so the pending list stops showing it. Repeating it changes nothing.
 * Context needs no marking (409 not_a_request). While another agent or
 * worker leases it or its conversation, 409 claimed_by_other: a worker of a
 * pool sends its instance_id.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const POST = withApi<ChatHandledInput, { id: string }>(async ({ supabase, params, body, access, teamMemberId, principalId }) => {
  requireAgentsEnabled(access);
  return success(await markMessageHandled(supabase, { memberId: teamMemberId, access, principalId }, params.id, body?.instance_id ?? null));
}, { schema: chatHandledSchema, optionalBody: true, permission: 'notifications.manage_own' });
