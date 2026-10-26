import { inboxRoute } from '@/lib/communications/inbox-route';
import { taskSourceEmails } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** The client emails a task came from or was updated by. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => taskSourceEmails(ctx, id));
}
