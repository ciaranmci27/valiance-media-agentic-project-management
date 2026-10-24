import { NextResponse } from 'next/server';
import { taskFileLink } from '@/lib/task-files/service';
import { taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

/**
 * Opens an image, PDF or text file in the browser: a redirect to a
 * five-minute link, so a thumbnail or preview pointing here never expires.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  return taskFilesRoute((ctx) => taskFileLink(ctx, id, fileId, { inline: true }), (link) => {
    const response = NextResponse.redirect(link.url, 302);
    response.headers.set('Cache-Control', 'private, max-age=240');
    return response;
  });
}
