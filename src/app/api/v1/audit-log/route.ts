import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const entityType = searchParams.get('entity_type');
  const entityId = searchParams.get('entity_id');
  const teamMemberId = searchParams.get('team_member_id');
  const method = searchParams.get('method');

  let query = supabase
    .from('api_audit_log')
    .select('*', { count: 'exact' });

  if (entityType) query = query.eq('entity_type', entityType);
  if (entityId) query = query.eq('entity_id', entityId);
  if (teamMemberId) query = query.eq('team_member_id', teamMemberId);
  if (method) query = query.eq('method', method);

  const { data, count, error } = await query
    .order('timestamp', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});
