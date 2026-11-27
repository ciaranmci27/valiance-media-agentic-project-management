import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { getAgentAccess, setAgentAccess, setAgentAccessSchema, type SetAgentAccess } from '@/lib/api/agent-hierarchy';

/**
 * An agent's place in the chart and who can use it: its orchestrator and the agents
 * under it, reachable_directly, ask_first, its audience (who can use it,
 * with exceptions) and the limits its orchestrators put on it (inherited, in plain
 * words), how many people can use it now, and whether the key may change it.
 *
 * Permission: team.read, with the AI agents module on.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  return success(await getAgentAccess(supabase, { memberId: teamMemberId, access, scopes }, params.id));
}, { permission: 'team.read' });

/**
 * Sets an agent's orchestrator (another company agent, no loops, at most 4 levels;
 * null takes it out of the chart), reachable_directly, ask_first and its
 * audience (replaced; an empty list lets in everyone who may otherwise give
 * it work). For an Owner, team.manage or agents.manage, or one of the
 * agent's owners (403 not_agent_owner); never the agent itself (403
 * own_access); never a personal assistant (422 personal_agent). Moving it to
 * a new orchestrator never moves work it already has. Answers the access as GET does.
 *
 * Permission: team.read (who may change it is decided inside), with the AI agents module on.
 */
export const PUT = withApi<SetAgentAccess, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const caller = { memberId: teamMemberId, access, scopes };
  const before = await getAgentAccess(supabase, caller, params.id);
  const after = await setAgentAccess(supabase, caller, params.id, body);
  logAudit(supabase, {
    method: 'PUT', endpoint: `/api/v1/agents/${params.id}/access`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId,
    requestBody: body, beforeSnapshot: before, afterSnapshot: after, statusCode: 200,
  });
  return success(after);
}, { schema: setAgentAccessSchema, permission: 'team.read' });
