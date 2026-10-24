import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { apiContext, createUploadLink } from '@/lib/task-files/service';

export const dynamic = 'force-dynamic';

/**
 * A link to upload one file of up to 50 MB to, valid for two hours: PUT the
 * bytes to upload_url, then add the file with POST /files { upload_id, name }.
 */
export const POST = withApi<unknown, { id: string }>(async (ctx) => {
  return created(await createUploadLink(apiContext(ctx), ctx.params.id));
}, { permission: 'files.upload' });
