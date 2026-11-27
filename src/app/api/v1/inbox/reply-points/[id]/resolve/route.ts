import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { resolveReplyPoint } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/**
 * A person marks a reply owed as done.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => resolveReplyPoint(inbox, params.id));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/reply-points/${params.id}/resolve`, entityType: 'email_reply_point', entityId: params.id });
  return success(result);
}, { permission: 'inbound_email.triage' });
