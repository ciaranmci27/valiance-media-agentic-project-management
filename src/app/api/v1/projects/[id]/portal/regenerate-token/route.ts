import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { regeneratePortalToken } from '@/lib/supabase/queries';

export const POST = withApi(async ({ supabase, params }) => {
  const { id } = params as any;
  const settings = await regeneratePortalToken(supabase, id);
  return success(settings);
});
