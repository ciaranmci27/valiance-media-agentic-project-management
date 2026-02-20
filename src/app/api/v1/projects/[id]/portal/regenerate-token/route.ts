import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { regeneratePortalToken } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const settings = await regeneratePortalToken(supabase, id);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/portal/regenerate-token`, entityType: 'portal_settings', entityId: id, apiKeyId, teamMemberId, afterSnapshot: settings, statusCode: 200 });
  return success(settings);
});
