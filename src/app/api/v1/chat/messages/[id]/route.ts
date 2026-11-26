import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { getAssistantMessage } from '@/lib/chat/messages';

/**
 * One chat message routed to the calling agent, with its text and the
 * thread so far: what a chat.message webhook points at (the webhook carries
 * ids only, so chat text never shows in delivery views). A company request
 * carries act_for: the body to mint a pass for its sender. 404 for a message
 * routed to another agent. Never cached.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId, principalId }) => {
  requireAgentsEnabled(access);
  const data = await getAssistantMessage(supabase, { memberId: teamMemberId, access, principalId }, params.id);
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'notifications.manage_own' });
