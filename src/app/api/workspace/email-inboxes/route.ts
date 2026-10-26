import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { createInbox, listInboxSettings } from '@/lib/communications/inbox-settings-service';
import { inboxSettingsSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

export async function GET() {
  return inboxRoute((ctx) => listInboxSettings(ctx));
}

export async function POST(request: Request) {
  return inboxRoute(async (ctx) => createInbox(ctx, await readBody(request, inboxSettingsSchema)), 201);
}
