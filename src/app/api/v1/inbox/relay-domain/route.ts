import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { setRelayDomain } from '@/lib/communications/inbox-settings-service';
import { relayDomainSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** The default routing domain for new inboxes; existing inboxes keep theirs. For whoever manages email inboxes. */
export const PUT = withApi<{ domain: string }>(async (ctx) => {
  const saved = await inboxApi(() => setRelayDomain(inboxContextOf(ctx), ctx.body.domain));
  auditInboxSetup(ctx, { method: 'PUT', endpoint: '/api/v1/inbox/relay-domain', entityType: 'business_settings', body: ctx.body, after: saved });
  return success(saved);
}, { schema: relayDomainSchema, permission: 'inbound_email.triage' });
