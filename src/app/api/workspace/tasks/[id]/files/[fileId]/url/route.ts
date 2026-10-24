import { taskFileLink } from '@/lib/task-files/service';
import { taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

/** A one-minute download link for the file. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  return taskFilesRoute((ctx) => taskFileLink(ctx, id, fileId));
}
