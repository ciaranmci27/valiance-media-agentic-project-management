import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { badRequest } from '@/lib/api/errors';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { listAssistantMessages } from '@/lib/chat/messages';
import { CHAT_MESSAGE_STATUSES } from '@/lib/chat/types';

/**
 * The chat messages routed to the calling assistant (a person's own agent),
 * oldest first: status pending (the default: nothing was sent to a webhook,
 * so they wait here), notified, replied, handled, unrouted or all; limit 1
 * to 100 (default 20). Each carries its text and the thread so far. No
 * act-for token: a personal agent is already narrowed to its person. Never
 * cached.
 *
 * Permission: notifications.manage_own (chat is the person's own channel,
 * like their bell), with the AI agents module on. Only a personal agent.
 */
export const GET = withApi(async ({ supabase, access, teamMemberId, searchParams }) => {
  requireAgentsEnabled(access);
  const status = searchParams.get('status') ?? 'pending';
  if (!(CHAT_MESSAGE_STATUSES as readonly string[]).includes(status)) throw badRequest(`status is one of ${CHAT_MESSAGE_STATUSES.join(', ')}`);
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 20) || 20, 1), 100);
  const data = await listAssistantMessages(supabase, { memberId: teamMemberId, access }, { status, limit });
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'notifications.manage_own' });
