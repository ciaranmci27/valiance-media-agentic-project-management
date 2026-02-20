import { withApi } from '@/lib/api/middleware';
import { success, created, paginated } from '@/lib/api/response';
import { createContactSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('contacts', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');

  let query = supabase.from('contacts').select('*', { count: 'exact' });

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
  const { data, error } = await supabase
    .from('contacts')
    .insert(body)
    .select()
    .single();

  if (error) throw error;
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/contacts', entityType: 'contact', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createContactSchema });
