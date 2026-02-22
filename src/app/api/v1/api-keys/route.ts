import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createApiKeySchema } from '@/lib/schemas';
import { generateApiKey, hashApiKey } from '@/lib/api/crypto';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase }) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const input = body as { name: string; permissions?: string; team_member_id?: string | null };

  const plainKey = generateApiKey();
  const keyHash = await hashApiKey(plainKey);
  const keyPrefix = plainKey.slice(0, 12) + '...';

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name: input.name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      permissions: input.permissions || 'full',
      created_by: teamMemberId || null,
      team_member_id: input.team_member_id ?? null,
    })
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/api-keys',
    entityType: 'api_key',
    entityId: data.id,
    apiKeyId,
    teamMemberId,
    requestBody: { name: input.name, permissions: input.permissions },
    afterSnapshot: data,
    statusCode: 201,
  });

  return created({ ...data, key: plainKey });
}, { schema: createApiKeySchema });
