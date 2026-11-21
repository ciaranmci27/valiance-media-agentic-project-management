import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { createMyInbox, listMyInboxes } from '@/lib/communications/inbox-settings-service';
import { myInboxSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Settings > Email > Your inbox: the signed-in person's own personal inboxes. */
export async function GET() {
  return inboxRoute((ctx) => listMyInboxes(ctx));
}

export async function POST(request: Request) {
  return inboxRoute(async (ctx) => createMyInbox(ctx, await readBody(request, myInboxSchema)), 201);
}
