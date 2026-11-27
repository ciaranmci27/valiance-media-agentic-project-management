import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { dismissMeeting } from '@/lib/communications/meeting/suggestions';

export const dynamic = 'force-dynamic';

/**
 * A meeting asked for no new work (Nothing to do): its waiting suggestions are skipped, its messages handled,
 * and the dismissal recorded. Answers the receipt, which POST .../nothing-to-do/undo takes back.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => dismissMeeting(inbox, params.threadId));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/nothing-to-do`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { permission: 'inbound_email.triage' });
