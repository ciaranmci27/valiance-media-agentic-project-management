import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createPortalUpdateSchema } from '@/lib/schemas';
import { insertPortalUpdate } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('portal_updates')
    .select('*, portal_update_attachments(id, name, file_url, file_size, mime_type, uploaded_by, created_at)', { count: 'exact' })
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const mapped = (data || []).map((u: any) => {
    const { portal_update_attachments, ...rest } = u;
    return { ...rest, attachments: portal_update_attachments || [] };
  });

  return paginated(mapped, { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const update = await insertPortalUpdate(supabase, {
    ...body as any,
    project_id: id,
    author_id: teamMemberId || null,
    pinned: false,
  });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/portal/updates`, entityType: 'portal_update', entityId: update.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: update, statusCode: 201 });
  return created(update);
}, { schema: createPortalUpdateSchema });
