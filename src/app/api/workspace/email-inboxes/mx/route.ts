import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { lookupMx } from '@/lib/inbound-email/inbox-settings-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Whether the routing domain has an MX record, by a live DNS lookup. */
export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get('domain') ?? '';
  return inboxRoute((ctx) => lookupMx(ctx, domain));
}
