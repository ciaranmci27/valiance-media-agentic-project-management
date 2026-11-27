import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { draftCopiedSchema, markDraftCopied } from '@/lib/communications/inbox-drafts';

export const dynamic = 'force-dynamic';

/**
 * A person copied the conversation's written reply draft into their own mail. Nothing is sent.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => markDraftCopied(inbox, params.threadId, body.draft_id));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/draft/copied`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: draftCopiedSchema, permission: 'inbound_email.triage' });
