import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeClientDomain } from '@/lib/communications/inbox-settings-service';

export const dynamic = 'force-dynamic';

/** A person removes a sender domain mapping (agents never delete mappings). */
export const DELETE = withApi<unknown, { id: string; domainId: string }>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  await inboxApi(() => removeClientDomain(inboxContextOf(ctx), ctx.params.id, ctx.params.domainId));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/projects/${ctx.params.id}/email-domains/${ctx.params.domainId}`, entityType: 'client_domain', entityId: ctx.params.domainId });
  return success({ removed: true });
}, { permission: ['contacts.manage', 'inbound_email.triage'] });
