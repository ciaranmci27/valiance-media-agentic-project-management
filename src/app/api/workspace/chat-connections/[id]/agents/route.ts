import { setConnectionAgents } from '@/lib/chat/connections';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { chatConnectionAgentsSchema } from '@/lib/chat/types';

export const dynamic = 'force-dynamic';

/**
 * Which company agents a company connection reaches (agent_ids) and the one
 * a DM goes to (default_agent_id, one of them, or null). Each must be a
 * shared agent that may act for people. Agents left out lose their channel
 * mappings. Owner only. Answers the connection.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access, memberId, appUrl }) => {
    const body = await readWorkspaceBody(request, chatConnectionAgentsSchema);
    return setConnectionAgents(service, access, memberId, id, body, appUrl);
  }, { noStore: true });
}
