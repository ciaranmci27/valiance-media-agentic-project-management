import { z } from 'zod';
import { RULE_ACTIONS } from './sorting';
import { describeRule, liveRuleFor, ruleTarget, RULE_COLUMNS, senderRuleSchema, type SenderRuleRow } from './sender-rules';
import { InboxError, assertCanTriage, canReadInbox, loadReadableThread, many, one, type InboxContext } from './inbox-service';
import { domainOf, organizationalDomain } from './addresses';

/**
 * Sender rules from the Inbox (session routes): list them, make one (from a
 * thread, optionally filtering that thread's open mail from the sender at
 * once), change what one does, switch one off or back on. A person's rule
 * replaces any rule for the same sender and topic, the agent's included.
 */

export interface InboxSenderRule extends SenderRuleRow {
  label: string;
  created_by_name: string | null;
}

export const createSenderRuleSchema = senderRuleSchema.extend({
  // Filter the open mail from this sender in this thread now, too.
  thread_id: z.string().uuid().nullable().default(null),
});
export type CreateSenderRuleRequest = z.infer<typeof createSenderRuleSchema>;

export const updateSenderRuleSchema = z.object({
  action: z.enum(RULE_ACTIONS).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((body) => body.action !== undefined || body.enabled !== undefined, { message: 'Nothing to change' });
export type UpdateSenderRuleRequest = z.infer<typeof updateSenderRuleSchema>;

async function present(ctx: InboxContext, rules: SenderRuleRow[]): Promise<InboxSenderRule[]> {
  const ids = [...new Set(rules.map((rule) => rule.created_by).filter((id): id is string => !!id))];
  const people = ids.length
    ? await many<{ id: string; name: string }>(ctx.service.from('team_members').select('id, name').in('id', ids))
    : [];
  const names = new Map(people.map((person) => [person.id, person.name]));
  return rules.map((rule) => ({ ...rule, label: describeRule(rule), created_by_name: rule.created_by ? names.get(rule.created_by) ?? null : null }));
}

/** Live rules first (newest first), then the switched-off ones. */
export async function listSenderRules(ctx: InboxContext): Promise<{ rules: InboxSenderRule[] }> {
  if (!canReadInbox(ctx.access)) throw new InboxError(403, 'Forbidden');
  const rows = await many<SenderRuleRow & Record<string, unknown>>(ctx.service.from('email_sender_rules').select(RULE_COLUMNS)
    .order('created_at', { ascending: false }).limit(500));
  const ordered = [...rows.filter((rule) => !rule.disabled_at), ...rows.filter((rule) => rule.disabled_at)];
  return { rules: await present(ctx, ordered) };
}

export async function createSenderRule(ctx: InboxContext, request: CreateSenderRuleRequest): Promise<{ rule: InboxSenderRule; filtered: number }> {
  assertCanTriage(ctx.access);
  const target = ruleTarget(request.match_kind, request.match_value);
  if (!target.ok) throw new InboxError(422, target.error);
  const thread = request.thread_id ? await loadReadableThread(ctx, request.thread_id) : null;

  // The same sender and topic: switched off and replaced, so the history shows both.
  const existing = await liveRuleFor(ctx.service, request.match_kind, target.value, request.topic);
  if (existing) {
    const { error } = await ctx.service.from('email_sender_rules')
      .update({ disabled_at: new Date().toISOString(), disabled_by: ctx.memberId }).eq('id', existing.id).is('disabled_at', null);
    if (error) throw error;
  }
  const rule = await one<SenderRuleRow & Record<string, unknown>>(ctx.service.from('email_sender_rules').insert({
    match_kind: request.match_kind,
    match_value: target.value,
    topic: request.topic,
    action: request.action,
    source: 'person',
    reason: request.reason,
    created_by: ctx.memberId,
  }).select(RULE_COLUMNS).single());
  if (!rule) throw new InboxError(500, 'Could not save the rule');

  let filtered = 0;
  if (thread && request.action === 'ignore') filtered = await filterThreadNow(ctx, thread.id, rule);
  return { rule: (await present(ctx, [rule]))[0], filtered };
}

/** The open mail in one thread from the rule's sender (and topic) is filtered now, as if it had just arrived. */
async function filterThreadNow(ctx: InboxContext, threadId: string, rule: SenderRuleRow): Promise<number> {
  const messages = await many<{ id: string; topic: string | null }>(ctx.service.from('email_messages')
    .select('id, topic').eq('thread_id', threadId).in('status', ['new', 'needs_human']));
  if (messages.length === 0) return 0;
  const senders = await many<{ message_id: string; address: string }>(ctx.service.from('email_message_recipients')
    .select('message_id, address').eq('kind', 'from').in('message_id', messages.map((message) => message.id)));
  const matches = (address: string) => {
    if (rule.match_kind === 'address') return address === rule.match_value;
    const domain = domainOf(address);
    return domain === rule.match_value || organizationalDomain(domain) === rule.match_value || domain.endsWith(`.${rule.match_value}`);
  };
  const ids = messages
    .filter((message) => (!rule.topic || message.topic === rule.topic) && senders.some((row) => row.message_id === message.id && matches(row.address)))
    .map((message) => message.id);
  if (ids.length === 0) return 0;
  const { error } = await ctx.service.from('email_messages').update({
    status: 'ignored',
    sort_action: 'ignore',
    sort_reason: `Filtered by the rule for ${describeRule(rule).replace(/^./, (first) => first.toLowerCase())}.`,
    sender_rule_id: rule.id,
  }).in('id', ids).in('status', ['new', 'needs_human']);
  if (error) throw error;
  return ids.length;
}

export async function updateSenderRule(ctx: InboxContext, ruleId: string, request: UpdateSenderRuleRequest): Promise<{ rule: InboxSenderRule }> {
  assertCanTriage(ctx.access);
  const rule = await one<SenderRuleRow & Record<string, unknown>>(ctx.service.from('email_sender_rules').select(RULE_COLUMNS).eq('id', ruleId).maybeSingle());
  if (!rule) throw new InboxError(404, 'Rule not found');
  const patch: Record<string, unknown> = {};
  if (request.action !== undefined) patch.action = request.action;
  if (request.enabled === false && !rule.disabled_at) {
    patch.disabled_at = new Date().toISOString();
    patch.disabled_by = ctx.memberId;
  }
  if (request.enabled === true && rule.disabled_at) {
    const live = await liveRuleFor(ctx.service, rule.match_kind, rule.match_value, rule.topic);
    if (live) throw new InboxError(409, `${describeRule(rule)} already has a rule. Change that one instead.`);
    patch.disabled_at = null;
    patch.disabled_by = null;
  }
  if (Object.keys(patch).length === 0) return { rule: (await present(ctx, [rule]))[0] };
  // A person's change makes the rule theirs.
  patch.source = 'person';
  const updated = await one<SenderRuleRow & Record<string, unknown>>(ctx.service.from('email_sender_rules')
    .update(patch).eq('id', rule.id).select(RULE_COLUMNS).single());
  if (!updated) throw new InboxError(404, 'Rule not found');
  return { rule: (await present(ctx, [updated]))[0] };
}
