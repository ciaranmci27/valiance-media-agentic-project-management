import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addClientDomain, listClientDomains } from '@/lib/communications/inbox-settings-service';
import { clientDomainSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Sender domains (project Email): mail from any address at one maps to this project. Read as the app reads them. */
export const GET = withApi<unknown, Params>(async (ctx) => {
  assertInboxOn(ctx.access);
  return success(await inboxApi(() => listClientDomains(inboxContextOf(ctx), ctx.params.id)));
}, { permission: ['contacts.read', 'inbound_email.read'] });

/** A person who manages contacts or email inboxes adds one; public mail domains are refused. Never an agent. */
export const POST = withApi<{ domain: string }, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const domain = await inboxApi(() => addClientDomain(inboxContextOf(ctx), ctx.params.id, ctx.body.domain));
  auditInboxSetup(ctx, { method: 'POST', endpoint: `/api/v1/projects/${ctx.params.id}/email-domains`, entityType: 'client_domain', entityId: domain.id, body: ctx.body, after: domain, statusCode: 201 });
  return created(domain);
}, { schema: clientDomainSchema, permission: ['contacts.manage', 'inbound_email.triage'] });
