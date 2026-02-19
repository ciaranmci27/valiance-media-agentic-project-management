import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updatePortalFileSchema } from '@/lib/schemas';
import { renamePortalFile, removePortalFile } from '@/lib/supabase/queries';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { fileId } = params as any;
  const file = await renamePortalFile(supabase, fileId, (body as any).name);
  return success(file);
}, { schema: updatePortalFileSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { fileId } = params as any;
  await removePortalFile(supabase, fileId);
  return success({ deleted: true });
});
