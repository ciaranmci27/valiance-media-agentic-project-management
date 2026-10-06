import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { setRelayDomain } from '@/lib/inbound-email/inbox-settings-service';
import { relayDomainSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** The default routing domain for new inboxes. Existing inboxes keep theirs. */
export async function PUT(request: Request) {
  return inboxRoute(async (ctx) => setRelayDomain(ctx, (await readBody(request, relayDomainSchema)).domain));
}
