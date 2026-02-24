import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { removePortalUpdateAttachment } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, updateId, attachmentId } = params as any;

  // Verify the update belongs to this project
  const { data: update } = await supabase
    .from('portal_updates')
    .select('id')
    .eq('id', updateId)
    .eq('project_id', id)
    .maybeSingle();
  if (!update) throw notFound('Portal update');

  // Verify the attachment belongs to this update
  const { data: before } = await supabase
    .from('portal_update_attachments')
    .select('*')
    .eq('id', attachmentId)
    .eq('update_id', updateId)
    .maybeSingle();
  if (!before) throw notFound('Attachment');

  await removePortalUpdateAttachment(supabase, attachmentId);

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${id}/portal/updates/${updateId}/attachments/${attachmentId}`,
    entityType: 'portal_update_attachment',
    entityId: attachmentId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });

  return success({ deleted: true });
});
