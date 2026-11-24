import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { putProjectAgent, removeProjectAgent } from '@/lib/api/project-agents';
import { putProjectAgentSchema, type PutProjectAgent } from '@/lib/schemas';

/**
 * Adds an agent to the project or changes its assignment: status (active or
 * paused), template_key, settings (checked against the template: 422
 * invalid_settings names each field) and instructions (up to 8000
 * characters). A new assignment also gives the agent project access, which only an Owner
 * or project_members.manage may do (403 project_access_needed for an owner of
 * the agent without it, on a project the agent is not on). Needs
 * project_members.manage, or a key whose member owns the agent; the project
 * must be one the key reaches. Answers { assignment, created, access_added }.
 *
 * Permission: project_members.manage or team.read (the owner check is the
 * route's), with the AI agents module on.
 */
export const PUT = withApi<PutProjectAgent, { id: string; agentId: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const result = await putProjectAgent(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.agentId, body);
  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/projects/${params.id}/agents/${params.agentId}`, entityType: 'project_agent', entityId: params.agentId, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result.assignment, statusCode: result.created ? 201 : 200 });
  return success(result, result.created ? 201 : 200);
}, { schema: putProjectAgentSchema, permission: ['project_members.manage', 'team.read'] });

/**
 * Takes the agent off the project. Its project access stays (change it with
 * set_agent_projects). Answers { removed, assignment }.
 */
export const DELETE = withApi<unknown, { id: string; agentId: string }>(async ({ supabase, params, access, scopes, apiKeyId, teamMemberId }) => {
  const result = await removeProjectAgent(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.agentId);
  if (result.removed) {
    logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${params.id}/agents/${params.agentId}`, entityType: 'project_agent', entityId: params.agentId, apiKeyId, teamMemberId, beforeSnapshot: result.assignment, statusCode: 200 });
  }
  return success(result);
}, { permission: ['project_members.manage', 'team.read'] });
