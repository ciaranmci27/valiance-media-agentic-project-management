import { inboxRoute } from '@/lib/communications/inbox-route';
import { markThreadHandled } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** A person dealt with the thread. Nothing is sent. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => markThreadHandled(ctx, id));
}
