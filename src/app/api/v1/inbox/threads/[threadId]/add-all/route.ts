import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { addAllSuggestions } from '@/lib/communications/meeting/suggestions';

export const dynamic = 'force-dynamic';

/**
 * Add all: every waiting suggestion of a meeting, accepted as the person's through the usual accept. Undo is per item.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => addAllSuggestions(inbox, params.threadId));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/add-all`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { permission: 'inbound_email.triage' });
