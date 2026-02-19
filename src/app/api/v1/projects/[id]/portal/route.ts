import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { upsertPortalSettingsSchema } from '@/lib/schemas';
import { fetchPortalSettings, upsertPortalSettings } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;
  const settings = await fetchPortalSettings(supabase, id);
  return success(settings);
});

export const PUT = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const settings = await upsertPortalSettings(supabase, id, body as any);
  return success(settings);
}, { schema: upsertPortalSettingsSchema });
