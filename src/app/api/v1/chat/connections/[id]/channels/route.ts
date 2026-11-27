import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { addChatChannel, apiConnectionView } from '@/lib/chat/connections';
import { createChatChannelSchema, type CreateChatChannelInput } from '@/lib/chat/types';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * Maps a channel of a company connection to one of its agents, as Settings
 * > Assistants > Chat apps does: channel is an id (Slack C0123, a Telegram
 * chat id) or a name the provider resolves (#general, a public group's
 * @username); listen is mentions (default) or all. The app asks the
 * provider with the stored bot token; the token never leaves the server.
 * 422 agent_not_on_connection, 409 channel_exists. Answers the connection
 * with its health (201). An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const POST = withApi<CreateChatChannelInput, { id: string }>(async ({ supabase, params, body, access, teamMemberId, apiKeyId, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const view = await addChatChannel(supabase, access, teamMemberId, params.id, body, appUrlFor(origin), { endpoint: `/api/v1/chat/connections/${params.id}/channels`, apiKeyId });
  return created(apiConnectionView(view));
}, { schema: createChatChannelSchema, permission: 'team.manage' });
