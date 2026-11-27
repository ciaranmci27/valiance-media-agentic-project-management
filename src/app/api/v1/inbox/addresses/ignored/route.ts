import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { ignoreAddress } from '@/lib/communications/inbox-settings-service';
import { ignoredAddressSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Not yours: an address mail arrived on is never suggested again (Your addresses' review). For whoever manages email inboxes. */
export const POST = withApi<{ address: string }>(async (ctx) => {
  await inboxApi(() => ignoreAddress(inboxContextOf(ctx), ctx.body.address));
  auditInboxSetup(ctx, { method: 'POST', endpoint: '/api/v1/inbox/addresses/ignored', entityType: 'ignored_address', body: ctx.body, statusCode: 201 });
  return created({ ignored: true });
}, { schema: ignoredAddressSchema, permission: 'inbound_email.triage' });
