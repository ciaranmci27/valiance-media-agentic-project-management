import { putProjectAgent, removeProjectAgent } from '@/lib/api/project-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { putProjectAgentSchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; agentId: string }> };

/**
 * Adds an agent to the project or changes its assignment: status, template,
 * settings (checked against the template; reason invalid_settings with
 * details.fields per field) and instructions. A new assignment also gives
 * the agent project access, for an Owner or project_members.manage only
 * (403 project_access_needed otherwise). For project_members.manage or the
 * agent's owners, on a project they reach. Answers { assignment, created, access_added }.
 */
export async function PUT(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, putProjectAgentSchema);
    const { id, agentId } = await params;
    return putProjectAgent(service, caller, id, agentId, body);
  });
}

/** Takes the agent off the project; its project access stays. Answers { removed, assignment }. */
export async function DELETE(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, agentId } = await params;
    return removeProjectAgent(service, caller, id, agentId);
  });
}
