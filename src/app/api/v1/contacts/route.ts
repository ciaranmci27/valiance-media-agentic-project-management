import { withApi } from '@/lib/api/middleware';
import { success, created, paginated } from '@/lib/api/response';
import { createContactSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { accessAllows } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('contacts', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');

  let query = supabase.from('contacts').select('*', { count: 'exact' });
  if (!accessAllows(access, 'contacts.read_all', 'api')) {
    if (access.project_ids.length === 0) return paginated([], { page, limit, total: 0 });
    const { data: links } = await supabase.from('project_contacts').select('contact_id').in('project_id', access.project_ids);
    const contactIds = [...new Set((links || []).map((row) => row.contact_id))];
    if (contactIds.length === 0) return paginated([], { page, limit, total: 0 });
    query = query.in('id', contactIds);
  }

  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order(sort, { ascending: order })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const contact = body as any;
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      notes: contact.notes,
      color: contact.color,
      avatar_url: contact.avatar_url || '',
      created_by: teamMemberId || null,
    })
    .select()
    .single();

  if (error) throw error;
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/contacts', entityType: 'contact', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createContactSchema });
