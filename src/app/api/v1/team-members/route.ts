import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createTeamMemberSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { accessAllows } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const search = searchParams.get('search');

  const selection = accessAllows(access, 'team.manage', 'api')
    ? '*'
    : 'id, name, email, avatar, role, status, timezone, created_at, updated_at';
  let query = supabase.from('team_members').select(selection, { count: 'exact' });

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

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  const member = body as Record<string, unknown>;
  if ((member.role === 'owner' || member.role === 'admin') && access.role !== 'owner') {
    throw forbidden('Only an Owner can create an Owner or Admin');
  }
  const emailNotificationsEnabled = member.email_notifications_enabled;
  const emailNotificationPrefs = member.email_notification_prefs;
  const { data, error } = await supabase
    .from('team_members')
    .insert({
      name: member.name,
      email: member.email,
      avatar: member.avatar || '',
      role: member.role || 'member',
      timezone: member.timezone || 'UTC',
      ...(typeof emailNotificationsEnabled === 'boolean' ? { email_notifications_enabled: emailNotificationsEnabled } : {}),
      ...(emailNotificationPrefs && typeof emailNotificationPrefs === 'object' ? { email_notification_prefs: emailNotificationPrefs } : {}),
    })
    .select()
    .single();

  if (error) throw error;
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/team-members', entityType: 'team_member', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createTeamMemberSchema });
