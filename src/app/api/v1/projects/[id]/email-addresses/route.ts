import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addProjectAddress, listProjectAddresses } from '@/lib/communications/inbox-settings-service';
import { projectAddressSchema, type ProjectAddressRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/**
 * A project's own email addresses (project Email): mail to one lands in its
 * inbox, filed on this project. Read by whoever reads the project's contacts
 * or its mail; added, changed and removed by a person who manages contacts
 * or email inboxes, never an agent, as in the app.
 */
export const GET = withApi<unknown, Params>(async (ctx) => {
  assertInboxOn(ctx.access);
  return success(await inboxApi(() => listProjectAddresses(inboxContextOf(ctx), ctx.params.id)));
}, { permission: ['contacts.read', 'inbound_email.read'] });

export const POST = withApi<ProjectAddressRequest, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const address = await inboxApi(() => addProjectAddress(inboxContextOf(ctx), ctx.params.id, ctx.body));
  auditInboxSetup(ctx, { method: 'POST', endpoint: `/api/v1/projects/${ctx.params.id}/email-addresses`, entityType: 'project_email_address', entityId: address.id, body: ctx.body, after: address, statusCode: 201 });
  return created(address);
}, { schema: projectAddressSchema, permission: ['contacts.manage', 'inbound_email.triage'] });
