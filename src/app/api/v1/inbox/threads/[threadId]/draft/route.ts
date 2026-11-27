import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { requestDraftSchema, requestReplyDraft } from '@/lib/communications/inbox-drafts';

export const dynamic = 'force-dynamic';

/**
 * Ask the inbox's agent to draft a reply to the conversation's newest email, optionally saying what to say.
 * One request waits per conversation. Nothing is sent.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => requestReplyDraft(inbox, params.threadId, body));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/draft`, entityType: 'email_thread', entityId: params.threadId, statusCode: 201 });
  return created(result);
}, { schema: requestDraftSchema, optionalBody: true, permission: 'inbound_email.triage' });
