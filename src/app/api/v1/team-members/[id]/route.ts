import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTeamMemberSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { accessAllows } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, params, access }) => {
  const selection = accessAllows(access, 'team.manage', 'api')
    ? '*'
    : 'id, name, email, avatar, role, status, timezone, created_at, updated_at';
  const { data, error } = await supabase
    .from('team_members')
    .select(selection)
    .eq('id', params.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Team member');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access }) => {
  const id = params.id;
  const { data: before } = await supabase.from('team_members').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Team member');
  const requested = body as Record<string, unknown>;
  if (before.role === 'owner' && ('role' in requested || 'status' in requested)) {
    throw forbidden('The Owner role and account status are immutable');
  }
  if ('role' in requested && access.role !== 'owner') {
    throw forbidden('Only an Owner can change roles');
  }

  const { data, error } = await supabase
    .from('team_members')
    .update(body)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Team member');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/team-members/${id}`, entityType: 'team_member', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateTeamMemberSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access }) => {
  const id = params.id;
  if (access.role !== 'owner') throw forbidden('Only an Owner can permanently delete a team member');
  const { data: before } = await supabase.from('team_members').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Team member');
  if (before.role === 'owner') throw forbidden('The Owner account is immutable');

  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/team-members/${id}`, entityType: 'team_member', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
