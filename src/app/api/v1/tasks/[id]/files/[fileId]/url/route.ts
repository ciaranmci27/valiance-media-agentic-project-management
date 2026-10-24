import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { apiContext, taskFileLink } from '@/lib/task-files/service';

export const dynamic = 'force-dynamic';

/**
 * A short link to the file: a one-minute download, or with ?inline=true a
 * five-minute link for images, PDFs and text. A linked email attachment opens
 * only if its inbox lets agents read that kind.
 */
export const GET = withApi<unknown, { id: string; fileId: string }>(async (ctx) => {
  const inline = ctx.searchParams.get('inline') === 'true';
  const link = await taskFileLink(apiContext(ctx), ctx.params.id, ctx.params.fileId, { inline });
  return success({ ...link, expires_at: new Date(Date.now() + link.expires_in * 1000).toISOString() });
}, { permission: 'files.read' });
