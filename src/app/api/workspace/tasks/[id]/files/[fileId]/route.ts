import { updateTaskFileSchema } from '@/lib/task-files/schemas';
import { trashTaskFile, updateTaskFile } from '@/lib/task-files/service';
import { readTaskFileBody, taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; fileId: string }> };

/** Renames the file or changes its note: your own, or any with files.manage. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, fileId } = await params;
  return taskFilesRoute(async (ctx) => updateTaskFile(ctx, id, fileId, await readTaskFileBody(request, updateTaskFileSchema)));
}

/** Moves the file to Trash: your own, or any with files.manage. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  return taskFilesRoute(async (ctx) => {
    await trashTaskFile(ctx, id, fileId);
    return { deleted: true };
  });
}
