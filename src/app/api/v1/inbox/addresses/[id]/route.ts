import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeYourAddress, updateYourAddress } from '@/lib/communications/inbox-settings-service';
import { yourAddressPatchSchema, type YourAddressPatch } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Change one of your addresses: its project, whose it is, its inbox, on or off. For whoever manages email inboxes. */
export const PATCH = withApi<YourAddressPatch, Params>(async (ctx) => {
  const address = await inboxApi(() => updateYourAddress(inboxContextOf(ctx), ctx.params.id, ctx.body));
  auditInboxSetup(ctx, { method: 'PATCH', endpoint: `/api/v1/inbox/addresses/${ctx.params.id}`, entityType: 'email_address', entityId: ctx.params.id, body: ctx.body, after: address });
  return success(address);
}, { schema: yourAddressPatchSchema, permission: 'inbound_email.triage' });

/** Remove one of your addresses. Mail it already brought in stays where it is. */
export const DELETE = withApi<unknown, Params>(async (ctx) => {
  await inboxApi(() => removeYourAddress(inboxContextOf(ctx), ctx.params.id));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/inbox/addresses/${ctx.params.id}`, entityType: 'email_address', entityId: ctx.params.id });
  return success({ removed: true });
}, { permission: 'inbound_email.triage' });
