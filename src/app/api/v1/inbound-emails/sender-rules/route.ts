import { comms } from '@/lib/communications/db';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { describeRule, liveRuleFor, PROTECTED_TOPICS, ruleTarget, rulesOverlap, RULE_COLUMNS, senderRuleSchema, type SenderRuleInput, type SenderRuleRow } from '@/lib/communications/sender-rules';

export const dynamic = 'force-dynamic';

/** The live sender rules, each with a plain label ("Usage alerts from okendo.io"). */
export const GET = withApi(async ({ supabase }) => {
  const { data, error } = await comms(supabase).from('sender_rules').select(RULE_COLUMNS).is('disabled_at', null).order('created_at', { ascending: false });
  if (error) throw error;
  return success(((data ?? []) as SenderRuleRow[]).map((rule) => ({ ...rule, label: describeRule(rule) })));
}, { permission: 'inbound_email.read' });

/**
 * The agent's rule, from a pattern it saw: always with a reason and one
 * topic, never money, account_risk or security (422). It replaces the
 * agent's own rule for the same sender and topic, and never overlaps a
 * person's rule, live or switched off by a person (409 person_rule): a
 * person's decision about a sender stands. Rules apply to mail that arrives
 * from now on.
 */
export const POST = withApi<SenderRuleInput>(async ({ supabase, body, teamMemberId, apiKeyId }) => {
  if (body.reason.length < 10) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'reason: say in a sentence what pattern this rule is based on');
  }
  if (!body.topic) {
    throw new ApiError(422, 'VALIDATION_ERROR', "topic: an agent's rule names the one topic it covers, so a sender's other mail still reaches triage");
  }
  if (PROTECTED_TOPICS.includes(body.topic)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `topic: ${body.topic} mail always reaches a person; no agent rule covers it`);
  }
  const target = ruleTarget(body.match_kind, body.match_value);
  if (!target.ok) throw new ApiError(422, 'VALIDATION_ERROR', target.error);
  const wanted = { match_kind: body.match_kind, match_value: target.value, topic: body.topic };
  // A person's rule that could match the same mail, or one a person switched off.
  const { data: peopleRules, error: peopleError } = await comms(supabase).from('sender_rules').select(`${RULE_COLUMNS}, disabled_by`)
    .or('source.eq.person,disabled_by.not.is.null');
  if (peopleError) throw peopleError;
  const rows = (peopleRules ?? []) as (SenderRuleRow & { disabled_by: string | null })[];
  const offIds = [...new Set(rows.map((row) => row.disabled_by).filter((id): id is string => !!id))];
  const { data: switchers, error: switcherError } = offIds.length
    ? await supabase.from('team_members').select('id, role').in('id', offIds)
    : { data: [], error: null };
  if (switcherError) throw switcherError;
  const byPerson = new Set(((switchers ?? []) as { id: string; role: string }[]).filter((member) => member.role !== 'agent').map((member) => member.id));
  const blocking = rows.find((row) => rulesOverlap(row, wanted)
    && ((row.source === 'person' && !row.disabled_at) || (!!row.disabled_by && byPerson.has(row.disabled_by))));
  if (blocking) {
    throw new ApiError(409, 'CONFLICT', `${describeRule(blocking)} is a person's decision (${blocking.disabled_at ? 'switched off' : blocking.action}); only a person changes it`, {
      reason: 'person_rule',
      rule: { ...blocking, label: describeRule(blocking) },
    });
  }
  const existing = await liveRuleFor(supabase, body.match_kind, target.value, body.topic);
  if (existing) {
    const { error } = await comms(supabase).from('sender_rules')
      .update({ disabled_at: new Date().toISOString(), disabled_by: teamMemberId }).eq('id', existing.id).is('disabled_at', null);
    if (error) throw error;
  }
  const { data, error } = await comms(supabase).from('sender_rules').insert({
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
