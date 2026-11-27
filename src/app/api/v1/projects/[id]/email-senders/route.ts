import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addClientSender, listClientSenders } from '@/lib/communications/inbox-settings-service';
import { clientSenderSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Sender addresses (project Email): mail from one maps to this project. Lists the project's contact addresses too. */
export const GET = withApi<unknown, Params>(async (ctx) => {
  assertInboxOn(ctx.access);
  return success(await inboxApi(() => listClientSenders(inboxContextOf(ctx), ctx.params.id)));
}, { permission: ['contacts.read', 'inbound_email.read'] });

/** A person who manages contacts or email inboxes adds one. Never an agent. */
export const POST = withApi<{ address: string }, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const sender = await inboxApi(() => addClientSender(inboxContextOf(ctx), ctx.params.id, ctx.body.address));
  auditInboxSetup(ctx, { method: 'POST', endpoint: `/api/v1/projects/${ctx.params.id}/email-senders`, entityType: 'client_sender', entityId: sender.id, body: ctx.body, after: sender, statusCode: 201 });
  return created(sender);
}, { schema: clientSenderSchema, permission: ['contacts.manage', 'inbound_email.triage'] });
