import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isHostname, normalizeAddress } from './email/addresses';
import { isPublicEmailDomain } from './email/public-domains';
import { MAIL_TOPICS, RULE_ACTIONS, type MailTopic, type RuleAction } from './sorting';
import { comms } from '@/lib/communications/db';

/**
 * Sender rules: what to do with mail from an address or a domain, for every
 * topic or one. People make them from the Inbox; the agent makes them from
 * patterns it sees (source agent, with a reason) and never over a person's
 * rule. Rules are switched off, never deleted. Sorting (sorting.ts) reads
 * the live ones as each email arrives.
 *
 * A rule is for the whole workspace (scope workspace, the default) or for one
 * inbox (scope inbox, inbox_id): an inbox's rule sorts only that inbox's mail.
 * What a workspace rule answers is unchanged: scope and inbox_id appear only
 * on an inbox's rule (presentRule).
 */

export interface SenderRuleRow {
  id: string;
  match_kind: 'address' | 'domain';
  match_value: string;
  topic: MailTopic | null;
  action: RuleAction;
  source: 'person' | 'agent';
  /** Only mail sent to this address; null for any. */
  recipient: string | null;
  reason: string;
  created_by: string | null;
  hit_count: number;
  last_hit_at: string | null;
  disabled_at: string | null;
  created_at: string;
  /** Read with RULE_SCOPE_COLUMNS: workspace, or inbox (only inbox_id's mail). Absent before the migration. */
  scope?: RuleScope;
  inbox_id?: string | null;
}

export const RULE_SCOPES = ['workspace', 'inbox'] as const;
export type RuleScope = typeof RULE_SCOPES[number];

export const RULE_COLUMNS = 'id, match_kind, match_value, topic, action, source, recipient, reason, created_by, hit_count, last_hit_at, disabled_at, created_at';
/** The rule's columns with its scope, for reads that need to know which inbox a rule is for. */
export const RULE_SCOPE_COLUMNS = `${RULE_COLUMNS}, scope, inbox_id`;

export const senderRuleSchema = z.object({
  match_kind: z.enum(['address', 'domain']),
  match_value: z.string().trim().min(3).max(320),
  topic: z.enum(MAIL_TOPICS).nullable().default(null),
  action: z.enum(RULE_ACTIONS),
  reason: z.string().trim().max(500).default(''),
  /** Left out: the workspace (an agent's rule may be inferred for its one inbox). inbox needs inbox_id. */
  scope: z.enum(RULE_SCOPES).optional(),
  inbox_id: z.string().uuid().optional(),
}).strict();
export type SenderRuleInput = z.infer<typeof senderRuleSchema>;

/** The inbox a rule is for, or null for the workspace; whether it was asked for explicitly is the caller's. */
export function ruleInboxOf(rule: Pick<SenderRuleRow, 'inbox_id'>): string | null {
  return rule.inbox_id ?? null;
}

/** A workspace rule answers exactly as before the scope existed; an inbox's rule adds scope and inbox_id. */
export function presentRule<T extends SenderRuleRow>(rule: T): T {
  const { scope, inbox_id: inboxId, ...rest } = rule;
  void scope;
  return (inboxId ? { ...rest, scope: 'inbox', inbox_id: inboxId } : rest) as T;
}

/** Whether a rule sorts this inbox's mail: a workspace rule, or this inbox's own. */
export function ruleAppliesTo(rule: Pick<SenderRuleRow, 'inbox_id'>, inboxId: string): boolean {
  const own = ruleInboxOf(rule);
  return own === null || own === inboxId;
}

/** Two rules' scopes can meet the same email: either is the workspace's, or both are one inbox's. */
export function scopesOverlap(a: Pick<SenderRuleRow, 'inbox_id'>, b: Pick<SenderRuleRow, 'inbox_id'>): boolean {
  const [x, y] = [ruleInboxOf(a), ruleInboxOf(b)];
  return x === null || y === null || x === y;
}

/** A missing column (the database before 20261124001000_inbox_handlers.sql). */
function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * Rules read with their scope; before the migration (no scope column) the
 * same read without it, every rule then being the workspace's.
 */
export async function readRules<T = SenderRuleRow>(build: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>, columns = RULE_COLUMNS): Promise<T[]> {
  const first = await build(`${columns}, scope, inbox_id`);
  if (!first.error) return (first.data ?? []) as T[];
  if (!isMissingColumn(first.error)) throw first.error;
  const second = await build(columns);
  if (second.error) throw second.error;
  return (second.data ?? []) as T[];
}

/** What to insert for a rule's scope: nothing for the workspace (the default), so the older database takes it too. */
export function scopeFields(inboxId: string | null): Record<string, string> {
  return inboxId ? { scope: 'inbox', inbox_id: inboxId } : {};
}

/** The address or domain a rule matches, cleaned, or why it cannot be one. */
export function ruleTarget(kind: 'address' | 'domain', value: string): { ok: true; value: string } | { ok: false; error: string } {
  if (kind === 'address') {
    const address = normalizeAddress(value);
    return address ? { ok: true, value: address } : { ok: false, error: 'Enter an email address such as alerts@tool.com.' };
  }
  const domain = value.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!isHostname(domain)) return { ok: false, error: 'Enter a domain such as tool.com.' };
  if (isPublicEmailDomain(domain)) {
    return { ok: false, error: `${domain} is a public email service, so a rule for all of it would catch people. Make a rule for the exact address instead.` };
  }
  return { ok: true, value: domain };
}

export const TOPIC_PLURALS: Record<MailTopic, string> = {
  money: 'Charges, invoices and receipts',
  account_risk: 'Account and payment problems',
  security: 'Security notices',
  usage: 'Usage alerts',
  event: 'Event invitations',
  newsletter: 'Newsletters',
  promotion: 'Promotions',
  update: 'Automatic updates',
  receipt: 'Receipts',
  calendar: 'Calendar replies',
  survey: 'Surveys',
  code: 'One-time codes',
};

/** "Usage alerts from okendo.io" / "Mail from no-reply@upwork.com" / "... to you@example.com". */
export function describeRule(rule: Pick<SenderRuleRow, 'match_value' | 'topic'> & { recipient?: string | null }): string {
  return `${rule.topic ? TOPIC_PLURALS[rule.topic] : 'Mail'} from ${rule.match_value}${rule.recipient ? ` to ${rule.recipient}` : ''}`;
}

/** Topics no rule from the agent may name: the Owner always sees this mail. */
export const PROTECTED_TOPICS: readonly MailTopic[] = ['money', 'receipt', 'account_risk', 'security'];

function sameOrUnder(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * True when two rules can match the same email: their senders overlap (one
 * address, or an address under the other's domain, or nested domains) and
 * their topics do (equal, or either covers every topic).
 */
export function rulesOverlap(
  a: Pick<SenderRuleRow, 'match_kind' | 'match_value' | 'topic'> & { recipient?: string | null },
  b: Pick<SenderRuleRow, 'match_kind' | 'match_value' | 'topic'> & { recipient?: string | null },
): boolean {
  if (a.topic && b.topic && a.topic !== b.topic) return false;
  if (a.recipient && b.recipient && a.recipient !== b.recipient) return false;
  const domainOfAddress = (value: string) => value.split('@')[1] ?? '';
  if (a.match_kind === 'address' && b.match_kind === 'address') return a.match_value === b.match_value;
  if (a.match_kind === 'domain' && b.match_kind === 'domain') {
    return sameOrUnder(a.match_value, b.match_value) || sameOrUnder(b.match_value, a.match_value);
  }
  const [address, domain] = a.match_kind === 'address' ? [a.match_value, b.match_value] : [b.match_value, a.match_value];
  return sameOrUnder(domainOfAddress(address), domain);
}

/** Every live rule with this sender and topic, for mail to any address, in any scope. */
export async function liveRulesForKey(supabase: SupabaseClient, kind: string, value: string, topic: string | null): Promise<SenderRuleRow[]> {
  return readRules((columns) => {
    let query = comms(supabase).from('sender_rules').select(columns)
      .eq('match_kind', kind).eq('match_value', value).is('recipient', null).is('disabled_at', null);
    query = topic ? query.eq('topic', topic) : query.is('topic', null);
    return query;
  });
}

/** The live rule with the same sender and topic, for mail to any address, in the same scope (null: the workspace), if any. */
export async function liveRuleFor(supabase: SupabaseClient, kind: string, value: string, topic: string | null, inboxId: string | null = null): Promise<SenderRuleRow | null> {
  return (await liveRulesForKey(supabase, kind, value, topic)).find((rule) => ruleInboxOf(rule) === inboxId) ?? null;
}

/** Switches rules off (never deletes them), as `memberId`. */
export async function switchOffRules(supabase: SupabaseClient, ruleIds: string[], memberId: string): Promise<void> {
  if (ruleIds.length === 0) return;
  const { error } = await comms(supabase).from('sender_rules')
    .update({ disabled_at: new Date().toISOString(), disabled_by: memberId }).in('id', ruleIds).is('disabled_at', null);
  if (error) throw error;
}
