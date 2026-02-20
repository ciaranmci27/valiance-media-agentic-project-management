import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { addLeadContactSchema } from '@/lib/schemas';
import { addLeadContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('lead_contacts')
    .select('*, contact:contacts(*)')
    .eq('lead_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const { contact_id, role, custom_role, is_primary_client } = body as any;
  const lc = await addLeadContact(supabase, id, contact_id, role, custom_role, is_primary_client);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/contacts`, entityType: 'lead_contact', entityId: lc.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: lc, statusCode: 201 });
  return created(lc);
}, { schema: addLeadContactSchema });
