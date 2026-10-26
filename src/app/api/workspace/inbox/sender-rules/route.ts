import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { createSenderRule, createSenderRuleSchema, listSenderRules } from '@/lib/communications/inbox-rules';

export const dynamic = 'force-dynamic';

/** Every sender rule, live ones first. */
export async function GET() {
  return inboxRoute((ctx) => listSenderRules(ctx));
}

/** A person's rule for a sender (and topic); with thread_id, that thread's open mail from them is filtered now. */
export async function POST(request: Request) {
  return inboxRoute(async (ctx) => createSenderRule(ctx, await readBody(request, createSenderRuleSchema)), 201);
}
