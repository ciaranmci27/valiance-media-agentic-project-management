import { createChatConnection, listChatConnections } from '@/lib/chat/connections';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createChatConnectionSchema } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

/** The workspace's chat connections, never a credential. Owner only. Answers { connections }. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access, appUrl }) => ({ connections: await listChatConnections(service, access, appUrl) }), { noStore: true });
}

/**
 * Connects Slack (bot_token, signing_secret) or Telegram (bot_token). The
 * app checks the credentials with the provider first (and sets Telegram's
 * webhook), then stores them encrypted; it needs APP_ENCRYPTION_KEY. Owner
 * only. Answers the connection with its inbound_url (Slack's Request URL).
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId, appUrl }) => {
    const body = await readWorkspaceBody(request, createChatConnectionSchema);
    return createChatConnection(service, access, memberId, body, appUrl);
  }, { status: 201, noStore: true });
}
