import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { addOwnDomain } from '@/lib/communications/inbox-settings-service';
import { ownDomainSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** A domain of yours: mail to any address on it reads as written to you. */
export async function POST(request: Request) {
  return inboxRoute(async (ctx) => addOwnDomain(ctx, (await readBody(request, ownDomainSchema)).domain), 201);
}
