import { agentTemplateView, listAgentTemplates } from '@/lib/agent-templates';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The agent templates the hire flow starts from: core's, then the install's,
 * each with its rules, scopes, brief, webhook events, the settings form it
 * asks for on each project, and the role and profile an agent from it starts
 * with. A template whose module is off is not listed. Any signed-in member
 * but a guest, with AI agents on: a template's brief can be an install's own
 * private text.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    requireAgentsEnabled(access);
    return { templates: listAgentTemplates(access).map(agentTemplateView) };
  });
}
