import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { updateSenderRule, updateSenderRuleSchema } from '@/lib/communications/inbox-rules';
import { assertId } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** Change what a rule does, or switch it off or back on. Rules are never deleted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateSenderRule(ctx, assertId(id, 'rule id'), await readBody(request, updateSenderRuleSchema)));
}
