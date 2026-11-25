import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { getAssistantMessage } from '@/lib/chat/messages';

/**
 * One chat message routed to the calling assistant, with its text and the
 * thread so far: what an assistant.message webhook points at (the webhook
 * carries ids only, so chat text never shows in delivery views). 404 for a
 * message routed to another agent. Never cached.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Only a personal agent.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId }) => {
  requireAgentsEnabled(access);
  const data = await getAssistantMessage(supabase, { memberId: teamMemberId, access }, params.id);
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: 'notifications.manage_own' });
