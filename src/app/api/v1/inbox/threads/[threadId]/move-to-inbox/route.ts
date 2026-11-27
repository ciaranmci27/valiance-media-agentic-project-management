import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { moveToInbox, moveToInboxSchema } from '@/lib/communications/inbox-rules';

export const dynamic = 'force-dynamic';

/**
 * A filtered pitch back to the Inbox (Move to Inbox): the agent reads it in full, and for a member who manages
 * inboxes its sender always from now on (a rule for that exact address).
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => moveToInbox(inbox, params.threadId, body.message_id));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/move-to-inbox`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: moveToInboxSchema, permission: 'inbound_email.triage' });
