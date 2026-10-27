import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { ignoreAddress } from '@/lib/communications/inbox-settings-service';
import { ignoredAddressSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Not yours: an address mail arrived on is never suggested again. */
export async function POST(request: Request) {
  return inboxRoute(async (ctx) => {
    await ignoreAddress(ctx, (await readBody(request, ignoredAddressSchema)).address);
    return { ignored: true };
  }, 201);
}
