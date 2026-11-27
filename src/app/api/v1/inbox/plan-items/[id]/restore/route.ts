import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { restorePlanItem } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/**
 * A person takes back an undo (the item's work comes back) or a skip (the suggestion waits again).
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => restorePlanItem(inbox, params.id));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/plan-items/${params.id}/restore`, entityType: 'email_plan_item', entityId: params.id });
  return success(result);
}, { permission: 'inbound_email.triage' });
