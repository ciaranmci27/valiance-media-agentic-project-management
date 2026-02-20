import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updatePortalFileSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { renamePortalFile, removePortalFile } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, fileId } = params as any;
  const { data: before } = await supabase.from('portal_files').select('*').eq('id', fileId).eq('project_id', id).maybeSingle();
  if (!before) throw notFound('Portal file');
  const file = await renamePortalFile(supabase, fileId, (body as any).name);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}/portal/files/${fileId}`, entityType: 'portal_file', entityId: fileId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: file, statusCode: 200 });
  return success(file);
}, { schema: updatePortalFileSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, fileId } = params as any;
  const { data: before } = await supabase.from('portal_files').select('*').eq('id', fileId).eq('project_id', id).maybeSingle();
  if (!before) throw notFound('Portal file');
  await removePortalFile(supabase, fileId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}/portal/files/${fileId}`, entityType: 'portal_file', entityId: fileId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
