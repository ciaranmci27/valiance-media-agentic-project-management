import { NextResponse } from 'next/server';
import { addTaskFileSchema } from '@/lib/task-files/schemas';
import { addTaskFile, listTaskFiles } from '@/lib/task-files/service';
import { readTaskFileBody, taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

/** The task's files, oldest first. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return taskFilesRoute((ctx) => listTaskFiles(ctx, id));
}

/** Adds an uploaded file (by upload_id), an email attachment or a project file. 201 when new. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return taskFilesRoute(
    async (ctx) => addTaskFile(ctx, id, await readTaskFileBody(request, addTaskFileSchema)),
    ({ file, created }) => NextResponse.json({ data: file }, { status: created ? 201 : 200 }),
  );
}
