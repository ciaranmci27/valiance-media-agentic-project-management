import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { subtaskRuleError } from '@/lib/api/subtasks';
import { assertAssigneesCanOpenProject } from '@/lib/api/task-guards';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ parent_task_id: z.string().uuid().nullable() });

/**
 * Makes a task a subtask of another task (parent_task_id) or top-level again
 * (null), as the signed-in member. set_task_parent runs on their own client,
 * so the database's rules and their rights decide; the one thing it cannot
 * see is whether the task's people could open another project, so a move
 * across projects checks that here first.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Their own client decides what they may change, so no one permission gates it.
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Send parent_task_id: a task id, or null' }, { status: 400 });
  const { client, service } = auth.data;
  const parentId = parsed.data.parent_task_id;

  try {
    if (parentId) {
      const [{ data: task }, { data: parent }] = await Promise.all([
        client.from('tasks').select('id, project_id, task_assignees(member_id)').eq('id', id).is('deleted_at', null).maybeSingle(),
        client.from('tasks').select('id, project_id').eq('id', parentId).is('deleted_at', null).maybeSingle(),
      ]);
      if (!task) return NextResponse.json({ error: 'That task is not there, or you cannot open it' }, { status: 404 });
      if (!parent) return NextResponse.json({ error: 'That parent task is not there, or you cannot open it' }, { status: 404 });
      if (parent.project_id !== task.project_id) {
        const assignees = ((task.task_assignees || []) as { member_id: string }[]).map((row) => row.member_id);
        if (assignees.length > 0) {
          await assertAssigneesCanOpenProject(service, assignees, parent.project_id).catch(() => {
            throw new ApiError(400, 'ASSIGNEE_OUTSIDE_PROJECT', "Someone on this task cannot open that task's project. Change who is on it first.");
          });
        }
      }
    }
    const { data, error } = await client.rpc('set_task_parent', { p_task_id: id, p_parent_id: parentId });
    if (error) throw subtaskRuleError(error);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof ApiError) {
      // A task the member cannot change reads as missing, like the database says.
      const message = error.statusCode === 404 ? 'That task is not there, or you cannot change it' : error.message;
      return NextResponse.json({ error: message }, { status: error.statusCode });
    }
    console.error('[tasks] set parent failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
