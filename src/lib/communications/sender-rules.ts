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
 */

export interface SenderRuleRow {
  id: string;
  match_kind: 'address' | 'domain';
  match_value: string;
  topic: MailTopic | null;
  action: RuleAction;
  source: 'person' | 'agent';
  reason: string;
  created_by: string | null;
  hit_count: number;
  last_hit_at: string | null;
  disabled_at: string | null;
  created_at: string;
}

export const RULE_COLUMNS = 'id, match_kind, match_value, topic, action, source, reason, created_by, hit_count, last_hit_at, disabled_at, created_at';

export const senderRuleSchema = z.object({
  match_kind: z.enum(['address', 'domain']),
  match_value: z.string().trim().min(3).max(320),
  topic: z.enum(MAIL_TOPICS).nullable().default(null),
  action: z.enum(RULE_ACTIONS),
  reason: z.string().trim().max(500).default(''),
}).strict();
export type SenderRuleInput = z.infer<typeof senderRuleSchema>;

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
};

/** "Usage alerts from okendo.io" / "Mail from no-reply@upwork.com". */
export function describeRule(rule: Pick<SenderRuleRow, 'match_value' | 'topic'>): string {
  return `${rule.topic ? TOPIC_PLURALS[rule.topic] : 'Mail'} from ${rule.match_value}`;
}

/** Topics no rule from the agent may name: Ciaran always sees this mail. */
export const PROTECTED_TOPICS: readonly MailTopic[] = ['money', 'account_risk', 'security'];

function sameOrUnder(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * True when two rules can match the same email: their senders overlap (one
 * address, or an address under the other's domain, or nested domains) and
 * their topics do (equal, or either covers every topic).
 */
export function rulesOverlap(a: Pick<SenderRuleRow, 'match_kind' | 'match_value' | 'topic'>, b: Pick<SenderRuleRow, 'match_kind' | 'match_value' | 'topic'>): boolean {
  if (a.topic && b.topic && a.topic !== b.topic) return false;
  const domainOfAddress = (value: string) => value.split('@')[1] ?? '';
  if (a.match_kind === 'address' && b.match_kind === 'address') return a.match_value === b.match_value;
  if (a.match_kind === 'domain' && b.match_kind === 'domain') {
    return sameOrUnder(a.match_value, b.match_value) || sameOrUnder(b.match_value, a.match_value);
  }
  const [address, domain] = a.match_kind === 'address' ? [a.match_value, b.match_value] : [b.match_value, a.match_value];
  return sameOrUnder(domainOfAddress(address), domain);
}

/** The live rule with the same sender and topic, if any. */
export async function liveRuleFor(supabase: SupabaseClient, kind: string, value: string, topic: string | null): Promise<SenderRuleRow | null> {
  let query = comms(supabase).from('sender_rules').select(RULE_COLUMNS)
    .eq('match_kind', kind).eq('match_value', value).is('disabled_at', null);
  query = topic ? query.eq('topic', topic) : query.is('topic', null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as SenderRuleRow | null) ?? null;
}
