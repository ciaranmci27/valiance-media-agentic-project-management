import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { lookupMx } from '@/lib/communications/inbox-settings-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Whether a routing domain has an MX record, by a live DNS lookup (never cached). For whoever manages email inboxes. */
export const GET = withApi(async (ctx) => success(await inboxApi(() => lookupMx(inboxContextOf(ctx), ctx.searchParams.get('domain') ?? ''))), { permission: 'inbound_email.read' });
