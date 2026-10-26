import { inboxRoute } from '@/lib/communications/inbox-route';
import { removeThreadProject } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** A person takes a project off the thread (refused while a task on it is linked). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const { id, projectId } = await params;
  return inboxRoute(async (ctx) => removeThreadProject(ctx, id, projectId));
}
