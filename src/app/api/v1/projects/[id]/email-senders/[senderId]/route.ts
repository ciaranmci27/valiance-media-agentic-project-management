import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeClientSender } from '@/lib/communications/inbox-settings-service';

export const dynamic = 'force-dynamic';

/** A person removes a sender address (agents never delete mappings). */
export const DELETE = withApi<unknown, { id: string; senderId: string }>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  await inboxApi(() => removeClientSender(inboxContextOf(ctx), ctx.params.id, ctx.params.senderId));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/projects/${ctx.params.id}/email-senders/${ctx.params.senderId}`, entityType: 'client_sender', entityId: ctx.params.senderId });
  return success({ removed: true });
}, { permission: ['contacts.manage', 'inbound_email.triage'] });
