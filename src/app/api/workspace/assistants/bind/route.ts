import { bindPersonalAgent } from '@/lib/api/personal-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { bindAssistantSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * Makes an agent someone's personal agent (person_id), or a shared agent
 * again (null). Owner only: who an agent works for never changes otherwise.
 * The person becomes its owner, in place of the one before. Re-binding or
 * unbinding revokes every key it holds, with their descendants, and every
 * delegation token it holds: a new key is needed for the new person.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, bindAssistantSchema);
    return bindPersonalAgent(service, caller, body.agent_id, body.person_id);
  });
}
