import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { apiConnectionView, listChatConnections } from '@/lib/chat/connections';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * The workspace's chat connections, as Settings > Assistants > Chat apps
 * lists them, each with its health (off, not_receiving, waiting,
 * needs_agents, connected, quiet): provider, kind, name, bot handle,
 * inbound_url, last heard and refused, and for a company connection its
 * agents, mapped channels, candidates and recent unmapped channels. Never a
 * token or secret. Answers { connections }. An Owner's key only.
 *
 * Connecting a chat app, or replacing its bot token or signing secret, stays
 * in the app (POST /api/workspace/chat-connections): a secret never passes
 * through an agent.
 *
 * Permission: team.manage, by an Owner.
 */
export const GET = withApi(async ({ supabase, access, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const connections = await listChatConnections(supabase, access, appUrlFor(origin));
  return success({ connections: connections.map(apiConnectionView) });
}, { permission: 'team.manage' });
