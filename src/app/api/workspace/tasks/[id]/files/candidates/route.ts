import { taskFileCandidates } from '@/lib/task-files/service';
import { taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

/** What can be added without uploading: the task's email attachments and its project's files. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return taskFilesRoute((ctx) => taskFileCandidates(ctx, id));
}
