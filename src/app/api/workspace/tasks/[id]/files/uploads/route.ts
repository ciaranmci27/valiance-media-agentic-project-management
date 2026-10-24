import { NextResponse } from 'next/server';
import { createUploadLink } from '@/lib/task-files/service';
import { taskFilesRoute } from '@/lib/task-files/session-route';

export const dynamic = 'force-dynamic';

/** A two-hour link the browser uploads one file to; then POST /files { upload_id, name }. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return taskFilesRoute((ctx) => createUploadLink(ctx, id), (data) => NextResponse.json({ data }, { status: 201 }));
}
