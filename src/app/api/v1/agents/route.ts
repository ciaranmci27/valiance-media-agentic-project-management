import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createAgentSchema, type CreateAgent } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { createAgentMember } from '@/lib/api/agent-setup';
import { addOwners, checkOwnerIds, ownersOf } from '@/lib/api/agent-owners';
import { agentFiltersFrom, listAgents } from '@/lib/api/agent-workspace';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';

/**
 * Adds an agent to the team, the way the Team page invites one: a login with
 * no password, then pm.add_team_member with the role agent. The role is
 * always agent (any other field is refused), and like the Team page only an
 * Owner adds an agent. Over the API no sign-in link is made: the agent works
 * through keys (POST /api/v1/api-keys). The Owner adding it becomes its
 * owner, with any owner_ids named (people, never agents). Answers with the
 * member and its owners.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const POST = withApi<CreateAgent>(async ({ supabase, body, access, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const { owner_ids: ownerIds, ...fields } = body;
  // Checked before the agent exists, so a bad owner adds nothing.
  const owners = await checkOwnerIds(supabase, null, [...(access.role === 'agent' ? [] : [teamMemberId]), ...(ownerIds ?? [])]);
  const data = await createAgentMember(supabase, access, fields);
  await addOwners(supabase, data.id, owners, teamMemberId);
  const result = { ...data, owners: (await ownersOf(supabase, [data.id])).get(data.id) ?? [] };
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agents', entityType: 'team_member', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 201 });
  return created(result);
}, { schema: createAgentSchema, permission: 'team.manage' });

/**
 * The agents, by name, paged: each with its role label, owners, template,
 * live health, current run and how many projects it is assigned to, in a
 * fixed number of reads however many there are. Filters: role, owner (me or
 * a member id), template, project, status (active or suspended), search.
 *
 * Permission: team.read (or team.manage), with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access, scopes, teamMemberId, searchParams }) => {
  requireAgentsEnabled(access);
  const { page, limit, offset } = parsePagination(searchParams);
  const result = await listAgents(supabase, { memberId: teamMemberId, access, scopes }, { ...agentFiltersFrom(searchParams), offset, limit });
  return paginated(result.rows, { page, limit, total: result.total });
}, { permission: 'team.read' });
