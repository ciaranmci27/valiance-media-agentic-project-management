import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { describeRule, liveRuleFor, ruleTarget, RULE_COLUMNS, senderRuleSchema, type SenderRuleInput, type SenderRuleRow } from '@/lib/inbound-email/sender-rules';

export const dynamic = 'force-dynamic';

/** The live sender rules, each with a plain label ("Usage alerts from okendo.io"). */
export const GET = withApi(async ({ supabase }) => {
  const { data, error } = await supabase.from('email_sender_rules').select(RULE_COLUMNS).is('disabled_at', null).order('created_at', { ascending: false });
  if (error) throw error;
  return success(((data ?? []) as SenderRuleRow[]).map((rule) => ({ ...rule, label: describeRule(rule) })));
}, { permission: 'inbound_email.read' });

/**
 * The agent's rule, from a pattern it saw: always with a reason. It replaces
 * the agent's own rule for the same sender and topic, and never a person's
 * (409 person_rule). Rules apply to mail that arrives from now on.
 */
export const POST = withApi<SenderRuleInput>(async ({ supabase, body, teamMemberId, apiKeyId }) => {
  if (body.reason.length < 10) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'reason: say in a sentence what pattern this rule is based on');
  }
  const target = ruleTarget(body.match_kind, body.match_value);
  if (!target.ok) throw new ApiError(422, 'VALIDATION_ERROR', target.error);
  const existing = await liveRuleFor(supabase, body.match_kind, target.value, body.topic);
  if (existing?.source === 'person') {
    throw new ApiError(409, 'CONFLICT', `${describeRule(existing)} already has a person's rule; only a person changes it`, {
      reason: 'person_rule',
      rule: { ...existing, label: describeRule(existing) },
    });
  }
  if (existing) {
    const { error } = await supabase.from('email_sender_rules')
      .update({ disabled_at: new Date().toISOString(), disabled_by: teamMemberId }).eq('id', existing.id).is('disabled_at', null);
    if (error) throw error;
  }
  const { data, error } = await supabase.from('email_sender_rules').insert({
    match_kind: body.match_kind,
    match_value: target.value,
    topic: body.topic,
    action: body.action,
    source: 'agent',
    reason: body.reason,
    created_by: teamMemberId,
  }).select(RULE_COLUMNS).single();
  if (error) throw error;
  const rule = { ...(data as SenderRuleRow), label: describeRule(data as SenderRuleRow) };
  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/inbound-emails/sender-rules',
    entityType: 'email_sender_rule',
    entityId: rule.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: rule,
    statusCode: 201,
  });
  return created({ rule, replaced_rule_id: existing?.id ?? null });
}, { schema: senderRuleSchema, permission: 'inbound_email.triage' });
