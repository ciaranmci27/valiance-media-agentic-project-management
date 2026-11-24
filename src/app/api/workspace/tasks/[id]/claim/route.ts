import { NextResponse } from 'next/server';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { releaseClaimAs } from '@/lib/api/claims';

export const dynamic = 'force-dynamic';

/**
 * Releases a stuck claim from the task card or panel. For people who may
 * manage every task: the claim is anyone's, so the right to release it is
 * tasks.manage_all on a project they can open.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  if (!accessAllows(access, 'tasks.manage_all', 'app')) {
    return NextResponse.json({ error: 'Releasing a claim takes the right to manage every task' }, { status: 403 });
  }
  const { data: task } = await service.from('tasks').select('id, project_id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!task || !accessAllowsProject(access, task.project_id, 'app')) {
    return NextResponse.json({ error: 'That task is not there, or you cannot open it' }, { status: 404 });
  }
  try {
    const data = await releaseClaimAs(service, memberId, id, true);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error('[tasks] release claim failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
