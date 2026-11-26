import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { replyToMessage } from '@/lib/chat/messages';
import { chatReplySchema, type ChatReplyInput } from '@/lib/chat/types';

/**
 * Replies to a chat message routed to the calling agent, under its own name
 * and avatar where the provider allows (Slack): in the conversation it came
 * from (its thread unless in_thread is false; a company answer in a channel
 * threads under the message, and also_send_to_channel shows it there too),
 * or to the sender by DM with private. Marks the message replied.
 *
 * A company request from a person needs X-Act-For naming them (403
 * act_for_required, act_for_mismatch). Context is never answered (409
 * not_a_request). 502 provider_refused with the provider's reason; 404 for
 * a message routed elsewhere. Send an Idempotency-Key to make a retry safe.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const POST = withApi<ChatReplyInput, { id: string }>(async ({ supabase, params, body, access, teamMemberId, principalId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const sent = await replyToMessage(supabase, { memberId: teamMemberId, access, principalId }, params.id, body);
  logAudit(supabase, {
    method: 'POST', endpoint: `/api/v1/chat/messages/${params.id}/reply`, entityType: 'chat_message', entityId: sent.id, apiKeyId, teamMemberId,
    requestBody: { reply_to: params.id, characters: body.text.length, private: sent.private, also_send_to_channel: body.also_send_to_channel === true }, statusCode: 201,
  });
  return success(sent, 201);
}, { schema: chatReplySchema, permission: 'notifications.manage_own' });
