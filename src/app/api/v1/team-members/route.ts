import { withApi } from '@/lib/api/middleware';
import { success, created, paginated } from '@/lib/api/response';
import { createTeamMemberSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const search = searchParams.get('search');

  let query = supabase.from('team_members').select('*', { count: 'exact' });

  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const member = body as any;
  const { data, error } = await supabase
    .from('team_members')
    .insert({
      name: member.name,
      email: member.email,
      avatar: member.avatar || '',
      role: member.role || 'member',
      auth_user_id: member.auth_user_id || null,
    })
    .select()
    .single();

  if (error) throw error;
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/team-members', entityType: 'team_member', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createTeamMemberSchema });
