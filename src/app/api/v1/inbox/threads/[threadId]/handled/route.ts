import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { markThreadHandled } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/**
 * A person dealt with the conversation (Mark handled): what waited on the agent or on a person is handled,
 * every email counts as reviewed, and their own open "Reply to" reminders from it close. Nothing is sent.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => markThreadHandled(inbox, params.threadId));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/handled`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { permission: 'inbound_email.triage' });
