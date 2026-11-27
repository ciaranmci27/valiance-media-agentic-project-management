import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { assertId } from '@/lib/communications/inbox-service';
import { updateSenderRule, updateSenderRuleSchema, type UpdateSenderRuleRequest } from '@/lib/communications/inbox-rules';

export const dynamic = 'force-dynamic';

/**
 * Change what a sender rule does (action), or switch it off or back on
 * (enabled). Rules are never deleted. The app's rule (Inbox > Rules): a
 * person needs to manage inboxes, and changing what a rule does makes it
 * theirs. An agent changes only agents' rules, never a person's or one a
 * person switched off (409 person_rule); a rule for one inbox only where it
 * acts on that inbox, and a personal agent never the workspace's. Switching
 * one back on while another rule covers the same sender is 409.
 */
export const PATCH = withApi<UpdateSenderRuleRequest>(async (ctx) => {
  const { params, body, supabase, apiKeyId, teamMemberId } = ctx;
  const result = await inboxApi(() => updateSenderRule(inboxContextOf(ctx), assertId(params.id, 'rule id'), body));
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/inbox/sender-rules/${params.id}`,
    entityType: 'email_sender_rule',
    entityId: result.rule.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: result.rule,
    statusCode: 200,
  });
  return success(result);
}, { schema: updateSenderRuleSchema, permission: 'inbound_email.triage' });
