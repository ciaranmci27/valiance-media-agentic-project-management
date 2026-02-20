import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createPortalFileSchema } from '@/lib/schemas';
import { fetchPortalFiles, insertPortalFile } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;
  const files = await fetchPortalFiles(supabase, id);
  return success(files);
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const file = await insertPortalFile(supabase, { ...body as any, project_id: id, uploaded_by: null });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/portal/files`, entityType: 'portal_file', entityId: file.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: file, statusCode: 201 });
  return created(file);
}, { schema: createPortalFileSchema });
