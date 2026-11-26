import { deleteChatChannel, updateChatChannel } from '@/lib/chat/connections';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateChatChannelSchema } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

/** Changes a mapped channel's agent or listen mode. Owner only. Answers the connection. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; channelId: string }> }) {
  const { id, channelId } = await params;
  return workspaceRoute(request, async ({ service, access, memberId, appUrl }) => {
    const body = await readWorkspaceBody(request, updateChatChannelSchema);
    return updateChatChannel(service, access, memberId, id, channelId, body, appUrl);
  }, { noStore: true });
}

/** Unmaps a channel: a mention of the bot there goes to the default agent again. Owner only. Answers the connection. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; channelId: string }> }) {
  const { id, channelId } = await params;
  return workspaceRoute(request, ({ service, access, memberId, appUrl }) => deleteChatChannel(service, access, memberId, id, channelId, appUrl), { noStore: true });
}
