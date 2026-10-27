import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { addYourAddress, listYourAddresses } from '@/lib/communications/inbox-settings-service';
import { yourAddressSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Your addresses and domains; ?review=1 also scans recent mail for addresses nobody listed. */
export async function GET(request: Request) {
  const review = new URL(request.url).searchParams.get('review') === '1';
  return inboxRoute((ctx) => listYourAddresses(ctx, { review }));
}

export async function POST(request: Request) {
  return inboxRoute(async (ctx) => addYourAddress(ctx, await readBody(request, yourAddressSchema)), 201);
}
