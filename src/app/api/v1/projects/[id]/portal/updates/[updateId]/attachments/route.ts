import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createPortalUpdateAttachmentSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { insertPortalUpdateAttachments } from '@/lib/supabase/queries';
import { z } from 'zod';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id, updateId } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  // Verify the update belongs to this project
  const { data: update } = await supabase
    .from('portal_updates')
    .select('id')
    .eq('id', updateId)
    .eq('project_id', id)
    .maybeSingle();
  if (!update) throw notFound('Portal update');

  const { data, count, error } = await supabase
    .from('portal_update_attachments')
    .select('*', { count: 'exact' })
    .eq('update_id', updateId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, updateId } = params as any;
  const entry = body as z.infer<typeof createPortalUpdateAttachmentSchema>;

  // Verify the update belongs to this project
  const { data: update } = await supabase
    .from('portal_updates')
    .select('id')
    .eq('id', updateId)
    .eq('project_id', id)
    .maybeSingle();
  if (!update) throw notFound('Portal update');

  const results = await insertPortalUpdateAttachments(supabase, [{
    update_id: updateId,
    name: entry.name,
    file_url: entry.file_url,
    file_size: entry.file_size,
    mime_type: entry.mime_type,
    uploaded_by: teamMemberId || null,
  }]);
  const attachment = results[0];
  if (!attachment) throw new Error('Failed to create attachment');

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${id}/portal/updates/${updateId}/attachments`,
    entityType: 'portal_update_attachment',
    entityId: attachment.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: attachment,
    statusCode: 201,
  });

  return created(attachment);
}, { schema: createPortalUpdateAttachmentSchema });
