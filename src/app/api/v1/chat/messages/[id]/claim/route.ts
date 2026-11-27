import { withApi } from '@/lib/api/middleware';
import { chatClaimHandler } from '@/lib/chat/claim-routes';
import { chatClaimSchema, type ChatClaimInput } from '@/lib/chat/claims';

/**
 * Claims the message for the calling agent (and its worker, instance_id)
 * for lease_minutes (default 30, 1 to 240): no other agent or worker replies
 * to it or marks it handled until the lease ends. Claiming again renews it.
 * 409 claimed_by_other names the holder.
 * 409 message_done for a message already replied or handled.
 * A host key (agents.host) sends agent_id: the lease is held in that agent's
 * name, for an agent the key serves.
 *
 * Permission: notifications.manage_own (an agent's own key) or agents.host (a
 * host key), with the AI agents module on.
 */
export const POST = withApi<ChatClaimInput, { id: string }>(chatClaimHandler('message', 'claim'), {
  schema: chatClaimSchema, optionalBody: true, permission: ['notifications.manage_own', 'agents.host'],
});
