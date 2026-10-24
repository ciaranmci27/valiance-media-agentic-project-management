import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { taskSource, TaskSourceError } from '@/lib/api/task-source';

export const dynamic = 'force-dynamic';

/** Where a task came from: who or what made it, through which key, and the email behind it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireSessionAccess({ permission: 'tasks.read' });
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await taskSource(auth.data, id) });
  } catch (error) {
    if (error instanceof TaskSourceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[tasks] source failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
