import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { createInbox, listInboxSettings } from '@/lib/communications/inbox-settings-service';
import { inboxSettingsSchema, type InboxSettingsRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * Settings > Email > Inboxes over the API, by the same functions as the app.
 * The key's member must manage email inboxes (inbound_email.manage on the
 * API: Owners by default), as in Settings. GET answers the shared inboxes in
 * full, the personal ones by health only, the relay domain and whether
 * Owners read personal inboxes. POST makes a shared inbox.
 */
export const GET = withApi(async (ctx) => success(await inboxApi(() => listInboxSettings(inboxContextOf(ctx)))), { permission: 'inbound_email.read' });

export const POST = withApi<InboxSettingsRequest>(async (ctx) => {
  const inbox = await inboxApi(() => createInbox(inboxContextOf(ctx), ctx.body));
  auditInboxSetup(ctx, { method: 'POST', endpoint: '/api/v1/inbox/inboxes', entityType: 'inbox', entityId: inbox.id, body: ctx.body, after: inbox, statusCode: 201 });
  return created(inbox);
}, { schema: inboxSettingsSchema, permission: 'inbound_email.triage' });
