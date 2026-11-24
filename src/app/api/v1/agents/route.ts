import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { createAgentSchema, type CreateAgent } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { createAgentMember } from '@/lib/api/agent-setup';
import { logAudit } from '@/lib/api/audit';

/**
 * Adds an agent to the team, the way the Team page invites one: a login with
 * no password, then pm.add_team_member with the role agent. The role is
 * always agent (any other field is refused), and like the Team page only an
 * Owner adds an agent. Over the API no sign-in link is made: the agent works
 * through keys (POST /api/v1/api-keys). Answers with the member.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const POST = withApi<CreateAgent>(async ({ supabase, body, access, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const data = await createAgentMember(supabase, access, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agents', entityType: 'team_member', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createAgentSchema, permission: 'team.manage' });
