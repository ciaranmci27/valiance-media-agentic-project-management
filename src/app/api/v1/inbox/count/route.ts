import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { attentionCount } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/**
 * The Inbox's badge: conversations that need a person, across every inbox
 * the key's member reads (needs_attention, the total, then the app's
 * attention counts by kind).
 */
export const GET = withApi(async (ctx) => {
  const attention = await inboxApi(() => attentionCount(inboxContextOf(ctx)));
  return success({ needs_attention: attention.total, ...attention });
}, { permission: 'inbound_email.read' });
