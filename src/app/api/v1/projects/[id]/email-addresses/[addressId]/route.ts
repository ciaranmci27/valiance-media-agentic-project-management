import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeProjectAddress, updateProjectAddress } from '@/lib/communications/inbox-settings-service';
import { projectAddressPatchSchema, type ProjectAddressPatch } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string; addressId: string };

/** A person edits an address in place (a new routing address retires the old one) or turns it on or off. Never an agent. */
export const PATCH = withApi<ProjectAddressPatch, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const address = await inboxApi(() => updateProjectAddress(inboxContextOf(ctx), ctx.params.id, ctx.params.addressId, ctx.body));
  auditInboxSetup(ctx, { method: 'PATCH', endpoint: `/api/v1/projects/${ctx.params.id}/email-addresses/${ctx.params.addressId}`, entityType: 'project_email_address', entityId: ctx.params.addressId, body: ctx.body, after: address });
  return success(address);
}, { schema: projectAddressPatchSchema, permission: ['contacts.manage', 'inbound_email.triage'] });

/** A person removes an address; conversations it filed keep their project. Never an agent. */
export const DELETE = withApi<unknown, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  await inboxApi(() => removeProjectAddress(inboxContextOf(ctx), ctx.params.id, ctx.params.addressId));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/projects/${ctx.params.id}/email-addresses/${ctx.params.addressId}`, entityType: 'project_email_address', entityId: ctx.params.addressId });
  return success({ removed: true });
}, { permission: ['contacts.manage', 'inbound_email.triage'] });
