import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const id = (params as any).id;
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('API key');
  return success(data);
});

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (!before) throw notFound('API key');

  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/api-keys/${id}`,
    entityType: 'api_key',
    entityId: id,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success({ revoked: true, id: data.id });
});
