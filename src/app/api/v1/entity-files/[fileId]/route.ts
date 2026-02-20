import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateEntityFileSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { fileId } = params as any;

  const { data, error } = await supabase
    .from('entity_files')
    .select('*')
    .eq('id', fileId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Entity file');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { fileId } = params as any;

  const { data: before } = await supabase
    .from('entity_files')
    .select('*')
    .eq('id', fileId)
    .maybeSingle();

  if (!before) throw notFound('Entity file');

  const { data, error } = await supabase
    .from('entity_files')
    .update(body as any)
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

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { fileId } = params as any;

  const { data: before } = await supabase
    .from('entity_files')
    .select('*')
    .eq('id', fileId)
    .maybeSingle();

  if (!before) throw notFound('Entity file');

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
