import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { undoAgentWork, undoAgentWorkSchema } from '@/lib/communications/agent-work';

export const dynamic = 'force-dynamic';

/**
 * Undo all: everything the agent did with these emails (message_ids; the whole conversation when left out),
 * or only its links to one task (task_id), taken back. Answers the receipt POST .../agent-work/restore takes.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => undoAgentWork(inbox, params.threadId, body));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/agent-work`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: undoAgentWorkSchema, optionalBody: true, permission: 'inbound_email.triage' });
