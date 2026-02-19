import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { removeLeadField } from '@/lib/supabase/queries';

export const DELETE = withApi(async ({ supabase, params }) => {
  const { fieldId } = params as any;
  await removeLeadField(supabase, fieldId);
  return success({ deleted: true });
});
