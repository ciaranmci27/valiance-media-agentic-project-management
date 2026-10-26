import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { setRelayDomain } from '@/lib/communications/inbox-settings-service';
import { relayDomainSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** The default routing domain for new inboxes. Existing inboxes keep theirs. */
export async function PUT(request: Request) {
  return inboxRoute(async (ctx) => setRelayDomain(ctx, (await readBody(request, relayDomainSchema)).domain));
}
