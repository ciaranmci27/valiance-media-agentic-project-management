import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { badRequest } from '@/lib/api/errors';
import { requireCaller } from '@/lib/chat/messages';
import { CONVERSATION_MESSAGES_DEFAULT, CONVERSATION_MESSAGES_MAX, getChatConversation } from '@/lib/chat/claims';

/**
 * One chat conversation (a DM, or a thread in a channel) the calling agent
 * has a message routed to: its messages oldest first (the newest limit, 1
 * to 200, default 50; a company conversation shows what was routed to this
 * agent and its own answers), its lease (claim: who holds it, which worker,
 * until when) and the running summary its agents keep (summary, written
 * with claim, extend or release). Every message carries chat_conversation_id;
 * anyone else's conversation reads as missing. Never cached.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId, principalId, searchParams }) => {
  requireAgentsEnabled(access);
  await requireCaller(supabase, { memberId: teamMemberId, access, principalId });
  const raw = searchParams.get('limit');
  const limit = raw === null ? CONVERSATION_MESSAGES_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_MESSAGES_MAX) {
    throw badRequest(`limit is a whole number from 1 to ${CONVERSATION_MESSAGES_MAX}`, { reason: 'invalid_limit' });
  }
  const data = await getChatConversation(supabase, teamMemberId, params.id, limit);
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'notifications.manage_own' });
