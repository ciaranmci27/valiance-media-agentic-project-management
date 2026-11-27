import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { apiConnectionView, deleteChatChannel, updateChatChannel } from '@/lib/chat/connections';
import { updateChatChannelSchema, type UpdateChatChannelInput } from '@/lib/chat/types';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

type Params = { id: string; channelId: string };

/**
 * Changes a mapped channel's agent (one of the connection's) or listen mode
 * (mentions or all). channelId is the mapping's id from the connection's
 * channels. Answers the connection with its health. An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const PATCH = withApi<UpdateChatChannelInput, Params>(async ({ supabase, params, body, access, teamMemberId, apiKeyId, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const view = await updateChatChannel(supabase, access, teamMemberId, params.id, params.channelId, body, appUrlFor(origin), {
    endpoint: `/api/v1/chat/connections/${params.id}/channels/${params.channelId}`, apiKeyId,
  });
  return success(apiConnectionView(view));
}, { schema: updateChatChannelSchema, permission: 'team.manage' });

/**
 * Unmaps a channel: a mention of the bot there goes to the default agent
 * again. Answers the connection with its health. An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const DELETE = withApi<unknown, Params>(async ({ supabase, params, access, teamMemberId, apiKeyId, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const view = await deleteChatChannel(supabase, access, teamMemberId, params.id, params.channelId, appUrlFor(origin), {
    endpoint: `/api/v1/chat/connections/${params.id}/channels/${params.channelId}`, apiKeyId,
  });
  return success(apiConnectionView(view));
}, { permission: 'team.manage' });
