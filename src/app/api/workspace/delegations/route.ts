import { mintForSession } from '@/lib/api/delegation';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { sessionDelegationSchema } from '@/lib/delegation';

export const dynamic = 'force-dynamic';

/**
 * Lets a named agent act for the signed-in member for 15 minutes: answers a
 * delegation token (shown once) for the agent's harness to send as
 * X-Act-For. The agent must hold Act for a person (agents.act_for). Never
 * cached.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    const body = await readWorkspaceBody(request, sessionDelegationSchema);
    return mintForSession(service, { memberId, access }, body.agent_id);
  }, { status: 201, noStore: true });
}
