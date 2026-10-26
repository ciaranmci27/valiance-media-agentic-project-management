import { inboxRoute } from '@/lib/communications/inbox-route';
import { undoPlanItem } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/** A person undoes one thing the agent did; a task changed since is left alone and reported. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => undoPlanItem(ctx, id));
}
