import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { badRequest } from '@/lib/api/errors';

export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const { page, limit, offset } = parsePagination(searchParams);
  const isRead = searchParams.get('is_read');
  const entityType = searchParams.get('entity_type');

  let query = supabase
    .from('team_member_notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', teamMemberId);

  if (isRead === 'true') query = query.eq('is_read', true);
  else if (isRead === 'false') query = query.eq('is_read', false);

  if (entityType) query = query.eq('entity_type', entityType);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});
