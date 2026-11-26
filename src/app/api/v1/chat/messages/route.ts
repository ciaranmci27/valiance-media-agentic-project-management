import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { badRequest } from '@/lib/api/errors';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { listAssistantMessages } from '@/lib/chat/messages';
import { sendChatMessage } from '@/lib/chat/outbound';
import { CHAT_MESSAGE_STATUSES, chatSendSchema, type ChatSendInput } from '@/lib/chat/types';

/**
 * The chat messages routed to the calling agent (a person's own assistant,
 * or a company agent on a company chat connection), oldest first: status
 * pending (the default: nothing was sent to a webhook, so they wait here),
 * notified, replied, handled, unrouted, context (channel messages recorded
 * for it to know, never to answer) or all; limit 1 to 100 (default 20).
 * Each carries its text, its connection kind, channel, whether it is a
 * request, act_for for a company request, and the thread so far. Never
 * cached.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const GET = withApi(async ({ supabase, access, teamMemberId, principalId, searchParams }) => {
  requireAgentsEnabled(access);
  const status = searchParams.get('status') ?? 'pending';
  if (!(CHAT_MESSAGE_STATUSES as readonly string[]).includes(status)) throw badRequest(`status is one of ${CHAT_MESSAGE_STATUSES.join(', ')}`);
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 20) || 20, 1), 100);
  const data = await listAssistantMessages(supabase, { memberId: teamMemberId, access, principalId }, { status, limit });
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'notifications.manage_own' });

/**
 * Starts a chat conversation: a personal assistant messages its own person
 * (a digest, an urgent alert) by DM; a company agent posts in a channel
 * mapped to it, or DMs a member while acting for them (X-Act-For) or, unasked,
 * with chat.notify. Optional link (url and label), shown the provider's way.
 * Under the agent's own name and avatar where the provider allows. Recorded
 * as a started message; a reply to it comes back to the same agent. 403
 * recipient_not_allowed, channel_not_allowed, chat_notify_required,
 * act_for_mismatch, not_on_connection; 409 no_linked_chat, choose_connection,
 * assistants_off; 429 chat_rate_limited; 423 while paused; 502
 * provider_refused. Send an Idempotency-Key to make a retry safe.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const POST = withApi<ChatSendInput>(async ({ supabase, body, access, teamMemberId, principalId, scopes, apiKeyId }) => {
  requireAgentsEnabled(access);
  const sent = await sendChatMessage(supabase, { memberId: teamMemberId, access, principalId, scopes }, body);
  logAudit(supabase, {
    method: 'POST', endpoint: '/api/v1/chat/messages', entityType: 'chat_message', entityId: sent.id, apiKeyId, teamMemberId,
    requestBody: { connection_id: sent.connection_id, direct: sent.direct, to: sent.to, characters: body.text.length, link: !!body.link }, statusCode: 201,
  });
  return success(sent, 201);
}, { schema: chatSendSchema, permission: 'notifications.manage_own' });
