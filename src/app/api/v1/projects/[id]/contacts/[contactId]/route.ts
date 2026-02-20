import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { updateProjectContact, removeProjectContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, contactId } = params as any;
  const { data: before } = await supabase.from('project_contacts').select('*').eq('id', contactId).maybeSingle();
  const pc = await updateProjectContact(supabase, contactId, id, body as any);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}/contacts/${contactId}`, entityType: 'project_contact', entityId: contactId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: pc, statusCode: 200 });
  return success(pc);
}, { schema: updateProjectContactSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, contactId } = params as any;
  const { data: before } = await supabase.from('project_contacts').select('*').eq('id', contactId).maybeSingle();
  await removeProjectContact(supabase, contactId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}/contacts/${contactId}`, entityType: 'project_contact', entityId: contactId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
