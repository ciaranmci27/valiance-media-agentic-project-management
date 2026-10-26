import { inboxRoute } from '@/lib/communications/inbox-route';
import { dismissPlanItem } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/** A person turns down the agent's proposal. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => dismissPlanItem(ctx, id));
}
