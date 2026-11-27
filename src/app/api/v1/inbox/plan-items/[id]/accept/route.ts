import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { acceptPlanItem, acceptPlanItemSchema } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/**
 * A person accepts the agent's proposal, optionally changing its project, task, title or date: applied as theirs.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => acceptPlanItem(inbox, params.id, body ?? {}));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/plan-items/${params.id}/accept`, entityType: 'email_plan_item', entityId: params.id });
  return success(result);
}, { schema: acceptPlanItemSchema, optionalBody: true, permission: 'inbound_email.triage' });
