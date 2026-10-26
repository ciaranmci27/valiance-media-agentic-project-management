import { inboxRoute } from '@/lib/communications/inbox-route';
import { attentionCount } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** The sidebar badge: threads that need a person (Needs you or Needs reply). */
export async function GET() {
  return inboxRoute(async (ctx) => {
    const attention = await attentionCount(ctx);
    return { needs_attention: attention.total, ...attention };
  });
}
