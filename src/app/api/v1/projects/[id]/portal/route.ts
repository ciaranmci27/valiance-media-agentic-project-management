import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { upsertPortalSettingsSchema } from '@/lib/schemas';
import { fetchPortalSettings, upsertPortalSettings } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;
  const settings = await fetchPortalSettings(supabase, id);
  return success(settings);
});

export const PUT = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const before = await fetchPortalSettings(supabase, id);
  const settings = await upsertPortalSettings(supabase, id, body as any);
  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/projects/${id}/portal`, entityType: 'portal_settings', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: settings, statusCode: 200 });
  return success(settings);
}, { schema: upsertPortalSettingsSchema });
