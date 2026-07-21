import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateEntityFileSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { accessAllowsEntity } from '@/lib/api/access';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';

async function requireFileScope(supabase: SupabaseClient, fileId: string, access: AccessContext, teamMemberId: string) {
  const { data, error } = await supabase.from('entity_files').select('*').eq('id', fileId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Entity file');
  if (!await accessAllowsEntity(supabase, access, teamMemberId, data.entity_type, data.entity_id, 'api')) {
    throw forbidden('Entity scope denied');
  }
  return data;
}

export const GET = withApi(async ({ supabase, params, access, teamMemberId }) => {
  const { fileId } = params as { fileId: string };
  const data = await requireFileScope(supabase, fileId, access, teamMemberId);
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access }) => {
  const { fileId } = params as { fileId: string };

  const before = await requireFileScope(supabase, fileId, access, teamMemberId);

  const { data, error } = await supabase
    .from('entity_files')
    .update(body as Record<string, unknown>)
    .eq('id', fileId)
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/entity-files/${fileId}`,
    entityType: 'entity_file',
    entityId: fileId,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success(data);
}, { schema: updateEntityFileSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access }) => {
  const { fileId } = params as { fileId: string };

  const before = await requireFileScope(supabase, fileId, access, teamMemberId);

  const { error } = await supabase
    .from('entity_files')
    .delete()
    .eq('id', fileId);

  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/entity-files/${fileId}`,
    entityType: 'entity_file',
    entityId: fileId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });

  return success({ deleted: true });
});
