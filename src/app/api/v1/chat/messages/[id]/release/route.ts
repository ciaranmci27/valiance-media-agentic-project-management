import { withApi } from '@/lib/api/middleware';
import { chatClaimHandler } from '@/lib/chat/claim-routes';
import { chatClaimSchema, type ChatClaimInput } from '@/lib/chat/claims';

/**
 * Ends your lease on the message (released false when you held none).
 * 409 claimed_by_other while someone else holds it.
 * A host key (agents.host) sends agent_id: the lease is held in that agent's
 * name, for an agent the key serves.
 *
 * Permission: notifications.manage_own (an agent's own key) or agents.host (a
 * host key), with the AI agents module on.
 */
export const POST = withApi<ChatClaimInput, { id: string }>(chatClaimHandler('message', 'release'), {
  schema: chatClaimSchema, optionalBody: true, permission: ['notifications.manage_own', 'agents.host'],
});
