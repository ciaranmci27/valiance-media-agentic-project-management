import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { moveThreadTasks, moveThreadTasksSchema } from '@/lib/communications/inbox-links';

export const dynamic = 'force-dynamic';

/**
 * The thread moved to another project: the tasks the agent made from it
 * follow, once the person confirms the list (a dry run lists them first).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => moveThreadTasks(ctx, id, await readBody(request, moveThreadTasksSchema)));
}
