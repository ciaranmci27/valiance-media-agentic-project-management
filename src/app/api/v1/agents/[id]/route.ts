import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { agentDetail, patchAgent } from '@/lib/api/agent-workspace';
import { logAudit } from '@/lib/api/audit';
import { patchAgentSchema, type PatchAgent } from '@/lib/schemas';

/**
 * One agent as the calling key may see it: who it is (role label,
 * description), rules, health, current run, its assignments on projects the
 * key's member reaches, owners, keys (never a secret; with
 * api_keys.manage_all), webhooks (with webhooks.manage), template_key,
 * can_manage and omitted.
 *
 * Permission: team.read (or team.manage), with the AI agents module on.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  return success(await agentDetail(supabase, { memberId: teamMemberId, access, scopes }, params.id));
}, { permission: 'team.read' });

/**
 * Changes an agent: name, title, description, avatar_url, agent_role and
 * rules for an Owner, a key with team.manage or one of the agent's owners
 * (403 not_agent_owner otherwise); owner_ids (people, never agents) for an
 * Owner or one of its owners. Keys stay the setup API's (create_api_key).
 * Answers { agent, rules, owners }.
 *
 * Permission: team.read (or team.manage), with the AI agents module on.
 */
export const PATCH = withApi<PatchAgent, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const { before, agent, rules, owners } = await patchAgent(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/agents/${params.id}`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: { agent, rules, owners }, statusCode: 200 });
  return success({ agent, rules, owners });
}, { schema: patchAgentSchema, permission: 'team.read' });
