import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addYourAddress, listYourAddresses } from '@/lib/communications/inbox-settings-service';
import { yourAddressSchema, type YourAddressRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * Settings > Email > Your addresses: the addresses people write to, each
 * with its project and whose it is, your own domains, and the inboxes an
 * address may deliver to. review=true also scans recent mail for addresses
 * nobody listed (unlisted). For whoever manages email inboxes.
 */
export const GET = withApi(async (ctx) => {
  const review = ctx.searchParams.get('review') === 'true' || ctx.searchParams.get('review') === '1';
  return success(await inboxApi(() => listYourAddresses(inboxContextOf(ctx), { review })));
}, { permission: 'inbound_email.read' });

export const POST = withApi<YourAddressRequest>(async (ctx) => {
  const address = await inboxApi(() => addYourAddress(inboxContextOf(ctx), ctx.body));
  auditInboxSetup(ctx, { method: 'POST', endpoint: '/api/v1/inbox/addresses', entityType: 'email_address', entityId: address.id, body: ctx.body, after: address, statusCode: 201 });
  return created(address);
}, { schema: yourAddressSchema, permission: 'inbound_email.triage' });
