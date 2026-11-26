import { agentFiltersFrom, hireAgent, listAgents } from '@/lib/api/agent-workspace';
import { forbidden } from '@/lib/api/errors';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { hireAgentSchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

/**
 * The agents, by name, paged (limit up to 200): each with its role label,
 * owners, template, live health, current run and assignment counts, in a
 * fixed number of reads however many there are. Filters: role, owner (me or
 * a member id), template, project, status, search. Any signed-in member but
 * a guest, with AI agents on. Answers { agents, meta }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 200, 100);
    const { rows, total } = await listAgents(service, caller, { ...agentFiltersFrom(searchParams), offset, limit });
    return { agents: rows, meta: pageMeta(page, limit, total) };
  });
}

/**
 * Hires an agent in one call (Owner only): the agent with no sign-in, its
 * template's role, profile and rules, its owners as owner_ids names them
 * (the hirer only when that is empty or left out),
 * project access and assignments with settings checked against the
 * template, optionally a key (its secret in this answer only, with
 * expires_at; a scope the agent role lacks is given to this agent as a
 * per-member allow first, by an Owner only: scopes_beyond_role), and how its
 * host connects. Never cached. A failure after the first write undoes what
 * the call made (reason hire_incomplete).
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller, granter, appUrl }) => {
    const body = await readWorkspaceBody(request, hireAgentSchema);
    return hireAgent(service, caller, granter, body, appUrl);
  }, { status: 201, noStore: true });
}
