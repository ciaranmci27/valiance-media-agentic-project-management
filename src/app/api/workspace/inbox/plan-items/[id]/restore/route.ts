import { inboxRoute } from '@/lib/communications/inbox-route';
import { restorePlanItem } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/** A person takes back an undo (the item's work comes back) or a skip (the suggestion waits again). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => restorePlanItem(ctx, id));
}
