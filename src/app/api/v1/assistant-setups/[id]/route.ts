import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { deleteAssistantSetup, updateAssistantSetup } from '@/lib/api/personal-agents';
import { updateAssistantSetupSchema, type UpdateAssistantSetup } from '@/lib/personal-agents';

/**
 * Changes a setup's template, settings or whether it is on. An Owner's key only.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const PATCH = withApi<UpdateAssistantSetup, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const setup = await updateAssistantSetup(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/assistant-setups/${params.id}`, entityType: 'assistant_setup', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: setup, statusCode: 200 });
  return success(setup);
}, { schema: updateAssistantSetupSchema, permission: 'assistants.provision' });

/** Removes a setup; agents it made stay with their people. */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, apiKeyId, teamMemberId }) => {
  const result = await deleteAssistantSetup(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/assistant-setups/${params.id}`, entityType: 'assistant_setup', entityId: params.id, apiKeyId, teamMemberId, statusCode: 200 });
  return success(result);
}, { permission: 'assistants.provision' });
