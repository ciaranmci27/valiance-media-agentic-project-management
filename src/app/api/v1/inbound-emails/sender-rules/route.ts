import { comms } from '@/lib/communications/db';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { inboxScope, inboxScopeDenied, memberInboxIds, memberTriageInboxIds } from '@/lib/communications/agent-access';
import { actingForOf } from '@/lib/communications/inbox-visibility';
import {
  describeRule, liveRulesForKey, presentRule, PROTECTED_TOPICS, readRules, ruleAppliesTo, ruleInboxOf, ruleTarget, rulesOverlap, RULE_COLUMNS, scopeFields, scopesOverlap, switchOffRules,
  senderRuleSchema, type SenderRuleInput, type SenderRuleRow,
} from '@/lib/communications/sender-rules';

export const dynamic = 'force-dynamic';

/**
 * The live sender rules, each with a plain label ("Usage alerts from
 * okendo.io"). An inbox's own rule also says scope inbox and its inbox_id.
 * With inbox_id (an inbox the key reads): only the rules that sort that
 * inbox's mail, the workspace's and its own. An agent acting for a person
 * (a personal agent) sees only the rules that sort the inboxes it reads.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxParam = searchParams.get('inbox_id');
  const inboxId = inboxParam ? (await inboxScope(supabase, teamMemberId, access, inboxParam))[0] : null;
  const readable = actingForOf(access) ? await memberInboxIds(supabase, teamMemberId, access) : null;
  const rules = await readRules<SenderRuleRow>((columns) => comms(supabase).from('sender_rules').select(columns).is('disabled_at', null).order('created_at', { ascending: false }));
  return success(rules
    .filter((rule) => !inboxId || ruleAppliesTo(rule, inboxId))
    .filter((rule) => !readable || readable.some((id) => ruleAppliesTo(rule, id)))
    .map((rule) => ({ ...presentRule(rule), label: describeRule(rule) })));
}, { permission: 'inbound_email.read' });

/**
 * The inbox a new agent rule is for, or null for the workspace: inbox_id
 * when it names one (scope inbox, or left out), never with scope workspace.
 * Neither sent, the workspace, as before scopes existed. A named inbox must
 * be one the key acts on. An agent acting for a person (a personal agent)
 * writes rules only for an inbox it acts on, never the workspace's.
 */
async function ruleInbox(supabase: Parameters<typeof memberTriageInboxIds>[0], memberId: string, access: Parameters<typeof memberTriageInboxIds>[2], body: SenderRuleInput): Promise<string | null> {
  if (actingForOf(access) && (body.scope === 'workspace' || !body.inbox_id)) {
    throw new ApiError(403, 'FORBIDDEN', "An assistant writes rules for its person's own inbox only: send inbox_id", { reason: 'inbox_rule_only' });
  }
  if (body.scope === 'workspace') {
    if (body.inbox_id) throw new ApiError(422, 'VALIDATION_ERROR', 'inbox_id: a workspace rule is for every inbox; leave inbox_id out, or use scope inbox');
    return null;
  }
  if (body.inbox_id) {
    if (!(await memberTriageInboxIds(supabase, memberId, access)).includes(body.inbox_id.toLowerCase())) throw inboxScopeDenied();
    return body.inbox_id.toLowerCase();
  }
  if (body.scope === 'inbox') throw new ApiError(422, 'VALIDATION_ERROR', 'inbox_id: a rule for one inbox names it');
  return null;
}

/**
 * The agent's rule, from a pattern it saw: always with a reason and one
 * topic, never money, account_risk or security (422). It replaces the
 * agent's own rule for the same sender and topic (in either scope), and never overlaps a
 * person's rule, live or switched off by a person (409 person_rule): a
 * person's decision about a sender stands. Rules apply to mail that arrives
 * from now on. scope and inbox_id are optional (ruleInbox): left out, the
 * rule is the workspace's, as before; a rule for one inbox meets only the
 * rules that can sort that inbox's mail.
 */
export const POST = withApi<SenderRuleInput>(async ({ supabase, body, teamMemberId, apiKeyId, access }) => {
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
  const inboxId = await ruleInbox(supabase, teamMemberId, access, body);
  const wanted = { match_kind: body.match_kind, match_value: target.value, topic: body.topic, inbox_id: inboxId };
  // A person's rule that could match the same mail, or one a person switched off.
  const rows = await readRules<SenderRuleRow & { disabled_by: string | null }>((columns) => comms(supabase).from('sender_rules').select(columns)
    .or('source.eq.person,disabled_by.not.is.null'), `${RULE_COLUMNS}, disabled_by`);
  const offIds = [...new Set(rows.map((row) => row.disabled_by).filter((id): id is string => !!id))];
  const { data: switchers, error: switcherError } = offIds.length
    ? await supabase.from('team_members').select('id, role').in('id', offIds)
    : { data: [], error: null };
  if (switcherError) throw switcherError;
  const byPerson = new Set(((switchers ?? []) as { id: string; role: string }[]).filter((member) => member.role !== 'agent').map((member) => member.id));
  const blocking = rows.find((row) => rulesOverlap(row, wanted) && scopesOverlap(row, wanted)
    && ((row.source === 'person' && !row.disabled_at) || (!!row.disabled_by && byPerson.has(row.disabled_by))));
  if (blocking) {
    throw new ApiError(409, 'CONFLICT', `${describeRule(blocking)} is a person's decision (${blocking.disabled_at ? 'switched off' : blocking.action}); only a person changes it`, {
      reason: 'person_rule',
      rule: { ...presentRule(blocking), label: describeRule(blocking) },
    });
  }
  // The live rule for the same sender and topic in this scope is replaced; so is this agent's own
  // rule for them in the other scope (its workspace rule, or its rules for single inboxes).
  const sameKey = await liveRulesForKey(supabase, body.match_kind, target.value, body.topic);
  const existing = sameKey.find((rule) => ruleInboxOf(rule) === inboxId) ?? null;
  const ownOtherScope = sameKey.filter((rule) => rule !== existing && rule.source === 'agent' && rule.created_by === teamMemberId
    && (inboxId ? ruleInboxOf(rule) === null : ruleInboxOf(rule) !== null));
  await switchOffRules(supabase, [...(existing ? [existing.id] : []), ...ownOtherScope.map((rule) => rule.id)], teamMemberId);
  const replacedId = existing?.id ?? ownOtherScope[0]?.id ?? null;
  const { data, error } = await comms(supabase).from('sender_rules').insert({
    match_kind: body.match_kind,
    match_value: target.value,
    topic: body.topic,
    action: body.action,
    source: 'agent',
    reason: body.reason,
    created_by: teamMemberId,
    ...scopeFields(inboxId),
  }).select(inboxId ? `${RULE_COLUMNS}, scope, inbox_id` : RULE_COLUMNS).single();
  if (error) throw error;
  const rule = { ...presentRule(data as unknown as SenderRuleRow), label: describeRule(data as unknown as SenderRuleRow) };
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
  return created({ rule, replaced_rule_id: replacedId });
}, { schema: senderRuleSchema, permission: 'inbound_email.triage' });
