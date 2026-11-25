import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { createAssistantSetup, listAssistantSetups } from '@/lib/api/personal-agents';
import { createAssistantSetupSchema, type CreateAssistantSetup } from '@/lib/personal-agents';

/**
 * Assistant setups, as Settings shows them: which template a role or a group
 * gets for its people's personal agents. An Owner's key only.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access, scopes, teamMemberId }) =>
  success(await listAssistantSetups(supabase, { memberId: teamMemberId, access, scopes })), { permission: 'assistants.provision' });

/** Adds a setup: match_role or match_group_id, template_key, settings, enabled. 409 setup_exists. */
export const POST = withApi<CreateAssistantSetup>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  const setup = await createAssistantSetup(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/assistant-setups', entityType: 'assistant_setup', entityId: setup.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: setup, statusCode: 201 });
  return created(setup);
}, { schema: createAssistantSetupSchema, permission: 'assistants.provision' });
