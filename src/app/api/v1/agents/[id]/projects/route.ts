import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { changeAgentProjects } from '@/lib/api/agent-setup';
import { logAudit } from '@/lib/api/audit';

const projectIds = z.array(z.string().uuid('Project ids must be uuids')).max(100);
const schema = z.object({ add: projectIds.optional(), remove: projectIds.optional() }).strict()
  .refine((body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0, 'Send a project to add or remove');
type Body = z.infer<typeof schema>;

/**
 * Adds an agent to projects and takes it off others. Only for agent members,
 * only on live projects the caller's own member reaches, the same rule as
 * changing a project's members on its screen. Answers with what changed and
 * the agent's projects now.
 *
 * Permission: project_members.manage, with the AI agents module on.
 */
export const PATCH = withApi<Body, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const result = await changeAgentProjects(supabase, { memberId: teamMemberId, access, scopes }, params.id, { add: body.add ?? [], remove: body.remove ?? [] });
  if (result.changed.length > 0) {
    logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/agents/${params.id}/projects`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { changed: result.changed, projects: result.projects }, statusCode: 200 });
  }
  return success(result);
}, { schema, permission: 'project_members.manage' });
