import { deleteChatConnection, updateChatConnection } from '@/lib/chat/connections';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateChatConnectionSchema } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

/** Renames a connection or switches it on or off. Owner only. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access, memberId, appUrl }) => {
    const body = await readWorkspaceBody(request, updateChatConnectionSchema);
    return updateChatConnection(service, access, memberId, id, body, appUrl);
  }, { noStore: true });
}

/** Removes a connection with its chat history (Telegram's webhook is deleted). Owner only. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return workspaceRoute(request, ({ service, access, memberId }) => deleteChatConnection(service, access, memberId, id));
}
