import { inboxRoute } from '@/lib/communications/inbox-route';
import { resolveReplyPoint } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/** A person marks a reply owed as done. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => resolveReplyPoint(ctx, id));
}
