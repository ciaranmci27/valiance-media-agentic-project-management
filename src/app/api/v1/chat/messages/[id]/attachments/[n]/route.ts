import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { fetchChatAttachment } from '@/lib/chat/attachments';

/**
 * One file sent with a chat message routed to the calling agent (a photo,
 * voice note, audio, video or document), n being its index in the message's
 * attachments. The app fetches it from the provider now and streams the
 * bytes through, with its type and name: the provider's address and the bot
 * token never leave the server. 404 for a message routed elsewhere or no
 * such file; 413 attachment_too_large past 20 MB; 502 provider_refused.
 * Never cached.
 *
 * Permission: notifications.manage_own, with the AI agents module on. Agents only.
 */
export const GET = withApi<unknown, { id: string; n: string }>(async ({ supabase, params, access, teamMemberId, principalId }) => {
  requireAgentsEnabled(access);
  return fetchChatAttachment(supabase, { memberId: teamMemberId, access, principalId }, params.id, params.n);
}, { permission: 'notifications.manage_own' });
