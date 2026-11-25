import { requireAgentsEnabled } from '@/lib/api/agents';
import { myPersonalAgents } from '@/lib/api/personal-agents';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own personal agents, newest first: each with its
 * template, status (paused_with_person when it was paused with them) and
 * live keys (never a secret). Any signed-in member, with AI agents on.
 * Answers { assistants }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    requireAgentsEnabled(access);
    return { assistants: await myPersonalAgents(service, memberId) };
  });
}
