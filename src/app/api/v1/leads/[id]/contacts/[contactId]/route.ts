import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { updateLeadContact, removeLeadContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, contactId } = params as any;
  const { data, error } = await supabase
    .from('lead_contacts')
    .select('*, contact:contacts(*)')
    .eq('id', contactId)
    .eq('lead_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead contact');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, contactId } = params as any;
  const { data: before } = await supabase.from('lead_contacts').select('*').eq('id', contactId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Lead contact');
  const lc = await updateLeadContact(supabase, contactId, id, body as any);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/leads/${id}/contacts/${contactId}`, entityType: 'lead_contact', entityId: contactId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: lc, statusCode: 200 });
  return success(lc);
}, { schema: updateLeadContactSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, contactId } = params as any;
  const { data: before } = await supabase.from('lead_contacts').select('*').eq('id', contactId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Lead contact');
  await removeLeadContact(supabase, contactId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}/contacts/${contactId}`, entityType: 'lead_contact', entityId: contactId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
