import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createLeadSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch } from '@/lib/api/pagination';
import { insertLead } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = searchParams.get('sort') || 'created_at';
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const source = searchParams.get('source');
  const assignedTo = searchParams.get('assigned_to');
  const includeArchived = searchParams.get('include_archived') === 'true';

  let query = supabase.from('leads').select('*, lead_members(member_id)', { count: 'exact' });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }
  if (status) query = query.eq('status', status);
  if (source) query = query.eq('source', source);
  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order(sort, { ascending: order })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const leads = (data || []).map((l: any) => ({
    ...l,
    member_ids: (l.lead_members || []).map((lm: any) => lm.member_id),
    lead_members: undefined,
  }));

  return paginated(leads, { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const { member_ids, ...leadData } = body as any;
  const lead = await insertLead(supabase, leadData, member_ids || []);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/leads', entityType: 'lead', entityId: lead.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: lead, statusCode: 201 });
  return created(lead);
}, { schema: createLeadSchema });
