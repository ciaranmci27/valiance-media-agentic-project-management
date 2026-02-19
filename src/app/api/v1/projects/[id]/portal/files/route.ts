import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createPortalFileSchema } from '@/lib/schemas';
import { fetchPortalFiles, insertPortalFile } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;
  const files = await fetchPortalFiles(supabase, id);
  return success(files);
});

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const file = await insertPortalFile(supabase, { ...body as any, project_id: id, uploaded_by: null });
  return created(file);
}, { schema: createPortalFileSchema });
