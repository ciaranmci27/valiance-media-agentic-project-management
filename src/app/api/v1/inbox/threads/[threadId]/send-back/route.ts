import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { sendBackToAgent } from '@/lib/communications/inbox-service';
import { sendBackSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * Back to the agent: the email (the newest by default) is New again and the agent plans it again; what its
 * earlier plans still waited on settles as superseded.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => sendBackToAgent(inbox, params.threadId, body.message_id ?? null));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/send-back`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { schema: sendBackSchema, optionalBody: true, permission: 'inbound_email.triage' });
