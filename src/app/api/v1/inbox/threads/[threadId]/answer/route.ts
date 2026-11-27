import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { answerAgentQuestion } from '@/lib/communications/inbox-service';
import { answerQuestionSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * A person answers the agent's question on an email (a decision card; the newest email asking by default):
 * the answer is kept and the email goes back to the agent with it.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => answerAgentQuestion(inbox, params.threadId, body.message_id ?? null, body.answer));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/answer`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: answerQuestionSchema, permission: 'inbound_email.triage' });
