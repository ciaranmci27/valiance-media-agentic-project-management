import { addChatChannel } from '@/lib/chat/connections';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createChatChannelSchema } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

/**
 * Maps a channel of a company connection to one of its agents: channel is an
 * id (Slack C0123, a Telegram chat id) or a name the provider resolves
 * (#general, a public group's @username); listen is mentions (default) or
 * all. Owner only. Answers the connection.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access, memberId, appUrl }) => {
    const body = await readWorkspaceBody(request, createChatChannelSchema);
    return addChatChannel(service, access, memberId, id, body, appUrl);
  }, { status: 201, noStore: true });
}
