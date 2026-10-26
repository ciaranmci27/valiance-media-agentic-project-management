import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { linkTaskSchema, linkThreadTask, unlinkThreadTask } from '@/lib/communications/inbox-links';
import { InboxError } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** A person ties the thread (its newest email, or the one named) to a task. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => linkThreadTask(ctx, id, await readBody(request, linkTaskSchema)), 201);
}

/** A person unties the thread from a task (?task_id=). The task itself stays. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const taskId = new URL(request.url).searchParams.get('task_id');
  return inboxRoute(async (ctx) => {
    if (!taskId) throw new InboxError(400, 'task_id is required');
    return unlinkThreadTask(ctx, id, taskId);
  });
}
