import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const entityType = searchParams.get('entity_type');
  const entityId = searchParams.get('entity_id');
  const type = searchParams.get('type');

  let query = supabase.from('activities').select('*', { count: 'exact' });

  if (entityType) query = query.eq('entity_type', entityType);
  if (entityId) query = query.eq('entity_id', entityId);
  if (type) query = query.eq('type', type);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});
