import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updatePortalUpdateSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchPortalUpdate } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, updateId } = params as any;
  const { data: before } = await supabase.from('portal_updates').select('*').eq('id', updateId).eq('project_id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Portal update');
  const update = await patchPortalUpdate(supabase, updateId, body as any);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}/portal/updates/${updateId}`, entityType: 'portal_update', entityId: updateId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: update, statusCode: 200 });
  return success(update);
}, { schema: updatePortalUpdateSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, updateId } = params as any;
  const { data: before } = await supabase.from('portal_updates').select('*').eq('id', updateId).eq('project_id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Portal update');
  await trashForApi(supabase, 'portal_updates', updateId, teamMemberId, 'Portal update');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}/portal/updates/${updateId}`, entityType: 'portal_update', entityId: updateId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
