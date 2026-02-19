import { withApi } from '@/lib/api/middleware';
import { success, created, paginated } from '@/lib/api/response';
import { createContactSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = searchParams.get('sort') || 'created_at';
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

export const POST = withApi(async ({ supabase, body }) => {
  const { data, error } = await supabase
    .from('contacts')
    .insert(body)
    .select()
    .single();

  if (error) throw error;
  return created(data);
}, { schema: createContactSchema });
