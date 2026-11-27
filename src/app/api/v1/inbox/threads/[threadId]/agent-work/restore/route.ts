import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { restoreAgentWork, restoreAgentWorkSchema } from '@/lib/communications/agent-work';

export const dynamic = 'force-dynamic';

/**
 * Restore all: what one Undo all took back, put back, as long as it belongs to this conversation. (The app
 * sends DELETE .../agent-work; a key posts here, since its DELETE carries no body.)
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => restoreAgentWork(inbox, params.threadId, body));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/agent-work/restore`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: restoreAgentWorkSchema, permission: 'inbound_email.triage' });
