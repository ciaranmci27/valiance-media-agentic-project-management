import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeOwnDomain } from '@/lib/communications/inbox-settings-service';

export const dynamic = 'force-dynamic';

/** Remove one of your domains. For whoever manages email inboxes. */
export const DELETE = withApi<unknown, { id: string }>(async (ctx) => {
  await inboxApi(() => removeOwnDomain(inboxContextOf(ctx), ctx.params.id));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/inbox/domains/${ctx.params.id}`, entityType: 'own_domain', entityId: ctx.params.id });
  return success({ removed: true });
}, { permission: 'inbound_email.triage' });
