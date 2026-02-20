import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createPortalFileSchema } from '@/lib/schemas';
import { insertPortalFile } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('portal_files')
    .select('*', { count: 'exact' })
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const file = await insertPortalFile(supabase, { ...body as any, project_id: id, uploaded_by: null });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/portal/files`, entityType: 'portal_file', entityId: file.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: file, statusCode: 201 });
  return created(file);
}, { schema: createPortalFileSchema });
