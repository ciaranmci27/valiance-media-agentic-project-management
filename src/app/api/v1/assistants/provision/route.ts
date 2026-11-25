import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { provisionAssistants } from '@/lib/api/personal-agents';
import { provisionAssistantsSchema, type ProvisionAssistants } from '@/lib/personal-agents';

/**
 * Makes a personal agent for every active person an enabled setup matches
 * who has none from its template, as POST /api/workspace/assistants/provision
 * does: idempotent, paged (limit, default 100, at most 500), dry_run pages
 * with after. Agents are made without keys. An Owner's key only.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const POST = withApi<ProvisionAssistants>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  const result = await provisionAssistants(supabase, { memberId: teamMemberId, access, scopes }, body);
  if (!body.dry_run) {
    logAudit(supabase, {
      method: 'POST', endpoint: '/api/v1/assistants/provision', apiKeyId, teamMemberId, requestBody: body,
      afterSnapshot: { made: result.agents.filter((agent) => agent.agent_id).length, remaining: result.remaining }, statusCode: 200,
    });
  }
  return success(result);
}, { schema: provisionAssistantsSchema, optionalBody: true, permission: 'assistants.provision' });
