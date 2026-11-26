import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { replyToMessage } from '@/lib/chat/messages';
import { chatReplySchema, type ChatReplyInput } from '@/lib/chat/types';

/**
 * Deprecated: the same path under /api/v1/chat/messages also serves company
 * agents. Kept, unchanged, for personal assistants.
 *
 * Replies to a chat message routed to the calling assistant, in the
 * conversation it came from (its thread, unless in_thread is false): the app
 * sends it through the provider (Slack chat.postMessage, Telegram
 * sendMessage) and marks the message replied. 502 provider_refused with the
 * provider's reason when it refuses; 404 for a message routed elsewhere.
 * Send an Idempotency-Key to make a retry safe.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Only a personal agent.
 */
export const POST = withApi<ChatReplyInput, { id: string }>(async ({ supabase, params, body, access, teamMemberId, principalId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const sent = await replyToMessage(supabase, { memberId: teamMemberId, access, principalId, personalOnly: true }, params.id, body);
  logAudit(supabase, {
    method: 'POST', endpoint: `/api/v1/assistant/messages/${params.id}/reply`, entityType: 'chat_message', entityId: sent.id, apiKeyId, teamMemberId,
    requestBody: { reply_to: params.id, characters: body.text.length }, statusCode: 201,
  });
  return success(sent, 201);
}, { schema: chatReplySchema, permission: 'notifications.manage_own' });
