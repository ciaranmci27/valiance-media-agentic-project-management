import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { setPersonalInboxEnabled, updateInbox } from '@/lib/communications/inbox-settings-service';
import { inboxSettingsSchema, inboxSwitchSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Edit a shared inbox, enable or disable it. Inboxes are never deleted here. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateInbox(ctx, id, await readBody(request, inboxSettingsSchema)));
}

/** Turn someone's personal inbox off or on (when they leave, say). Nothing else about it changes. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => setPersonalInboxEnabled(ctx, id, (await readBody(request, inboxSwitchSchema)).enabled));
}
