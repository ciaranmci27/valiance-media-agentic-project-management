import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { createInbox, listInboxSettings } from '@/lib/inbound-email/inbox-settings-service';
import { inboxSettingsSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

export async function GET() {
  return inboxRoute((ctx) => listInboxSettings(ctx));
}

export async function POST(request: Request) {
  return inboxRoute(async (ctx) => createInbox(ctx, await readBody(request, inboxSettingsSchema)), 201);
}
