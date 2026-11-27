import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { setPersonalInboxEnabled, updateInbox } from '@/lib/communications/inbox-settings-service';
import { inboxSettingsSchema, inboxSwitchSchema, type InboxSettingsRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/**
 * Edit a shared inbox (the whole form, as Settings sends it; inboxes are
 * never deleted). Changing its routing address clears verified_at, so the
 * forwarder must be verified again. Who gets its decisions is an Owner's
 * choice. The key's member must manage email inboxes.
 */
export const PUT = withApi<InboxSettingsRequest, Params>(async (ctx) => {
  const inbox = await inboxApi(() => updateInbox(inboxContextOf(ctx), ctx.params.id, ctx.body));
  auditInboxSetup(ctx, { method: 'PUT', endpoint: `/api/v1/inbox/inboxes/${ctx.params.id}`, entityType: 'inbox', entityId: inbox.id, body: ctx.body, after: inbox });
  return success(inbox);
}, { schema: inboxSettingsSchema, permission: 'inbound_email.triage' });

/**
 * Turn someone's personal inbox off or on (when they leave, say). Nothing
 * else about it changes, and its mail is never read here. A shared inbox is
 * 409: change it with PUT.
 */
export const PATCH = withApi<{ enabled: boolean }, Params>(async (ctx) => {
  const health = await inboxApi(() => setPersonalInboxEnabled(inboxContextOf(ctx), ctx.params.id, ctx.body.enabled));
  auditInboxSetup(ctx, { method: 'PATCH', endpoint: `/api/v1/inbox/inboxes/${ctx.params.id}`, entityType: 'inbox', entityId: ctx.params.id, body: ctx.body });
  return success(health);
}, { schema: inboxSwitchSchema, permission: 'inbound_email.triage' });
