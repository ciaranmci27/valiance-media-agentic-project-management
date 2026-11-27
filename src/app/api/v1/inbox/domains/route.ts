import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addOwnDomain } from '@/lib/communications/inbox-settings-service';
import { ownDomainSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** A domain of yours: mail to any address on it reads as written to you. Listed by GET /api/v1/inbox/addresses. For whoever manages email inboxes. */
export const POST = withApi<{ domain: string }>(async (ctx) => {
  const domain = await inboxApi(() => addOwnDomain(inboxContextOf(ctx), ctx.body.domain));
  auditInboxSetup(ctx, { method: 'POST', endpoint: '/api/v1/inbox/domains', entityType: 'own_domain', entityId: domain.id, body: ctx.body, after: domain, statusCode: 201 });
  return created(domain);
}, { schema: ownDomainSchema, permission: 'inbound_email.triage' });
