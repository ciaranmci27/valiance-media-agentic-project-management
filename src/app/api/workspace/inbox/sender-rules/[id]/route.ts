import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { updateSenderRule, updateSenderRuleSchema } from '@/lib/inbound-email/inbox-rules';
import { assertId } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/** Change what a rule does, or switch it off or back on. Rules are never deleted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateSenderRule(ctx, assertId(id, 'rule id'), await readBody(request, updateSenderRuleSchema)));
}
