import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { attentionCount } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/** The sidebar badge: threads that need a person (Needs you or Needs reply). */
export async function GET() {
  return inboxRoute(async (ctx) => ({ needs_attention: await attentionCount(ctx) }));
}
