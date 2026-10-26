import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { updateInbox } from '@/lib/communications/inbox-settings-service';
import { inboxSettingsSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Edit an inbox, enable or disable it. Inboxes are never deleted here. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateInbox(ctx, id, await readBody(request, inboxSettingsSchema)));
}
