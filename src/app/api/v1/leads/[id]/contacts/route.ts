import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { addLeadContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { addLeadContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('lead_contacts')
    .select('*, contact:contacts(*)', { count: 'exact' })
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: lead } = await supabase.from('leads').select('id').eq('id', id).maybeSingle();
  if (!lead) throw notFound('Lead');

  const { contact_id, role, custom_role, is_primary_client } = body as any;
  const lc = await addLeadContact(supabase, id, contact_id, role, custom_role, is_primary_client);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/contacts`, entityType: 'lead_contact', entityId: lc.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: lc, statusCode: 201 });
  return created(lc);
}, { schema: addLeadContactSchema });
