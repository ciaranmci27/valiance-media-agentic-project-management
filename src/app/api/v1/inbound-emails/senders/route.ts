import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/inbound-email/agent-access';
import { domainOf, organizationalDomain } from '@/lib/inbound-email/addresses';
import { describeRule, RULE_COLUMNS, type SenderRuleRow } from '@/lib/inbound-email/sender-rules';
import { matchRule, type MailTopic } from '@/lib/inbound-email/sorting';
import { fetchAllRows } from '@/lib/supabase/fetch-all';

export const dynamic = 'force-dynamic';

const MAX_MESSAGES = 3000;
const CHUNK = 100;

interface MessageRow { id: string; kind: string | null; topic: string | null; sort_action: string | null; received_at: string }

/**
 * Patterns for sender rules: who sent mail to the key's inboxes in the last
 * `days` (default 30, at most 90), busiest first. Per sender: how many
 * emails, their kinds, topics and sorting actions, the latest triage
 * outcomes, how many tasks they led to, and the live rules that cover them.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, searchParams.get('inbox_id'));
  const days = Math.min(90, Math.max(1, Number(searchParams.get('days') ?? 30) || 30));
  if (inboxIds.length === 0) return success({ days, senders: [] });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const messages = (await fetchAllRows<MessageRow>((from, to, count) =>
    supabase.from('email_messages').select('id, kind, topic, sort_action, received_at', { count })
      .in('inbox_id', inboxIds).neq('status', 'receiving').gte('received_at', since)
      .order('received_at', { ascending: false }).range(from, to))).slice(0, MAX_MESSAGES);
  const ids = messages.map((message) => message.id);
  const senders: { message_id: string; address: string; name: string }[] = [];
  const triage: { message_id: string; outcome: string; created_at: string }[] = [];
  const links: { message_id: string; task_id: string }[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [s, t, l] = await Promise.all([
      supabase.from('email_message_recipients').select('message_id, address, name').eq('kind', 'from').in('message_id', chunk),
      supabase.from('email_triage').select('message_id, outcome, created_at').in('message_id', chunk),
      supabase.from('email_task_links').select('message_id, task_id').in('message_id', chunk),
    ]);
    if (s.error) throw s.error;
    if (t.error) throw t.error;
    if (l.error) throw l.error;
    senders.push(...(s.data ?? []) as typeof senders);
    triage.push(...(t.data ?? []) as typeof triage);
    links.push(...(l.data ?? []) as typeof links);
  }
  const { data: ruleRows, error: ruleError } = await supabase.from('email_sender_rules').select(RULE_COLUMNS).is('disabled_at', null);
  if (ruleError) throw ruleError;
  const rules = (ruleRows ?? []) as SenderRuleRow[];

  const latestOutcome = new Map<string, { outcome: string; created_at: string }>();
  for (const row of triage) {
    const prior = latestOutcome.get(row.message_id);
    if (!prior || row.created_at > prior.created_at) latestOutcome.set(row.message_id, row);
  }
  const tally = (values: (string | null | undefined)[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) if (value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  };
  const senderOf = new Map(senders.map((row) => [row.message_id, row]));
  const byAddress = new Map<string, { name: string; messages: MessageRow[] }>();
  for (const message of messages) {
    const sender = senderOf.get(message.id);
    if (!sender) continue;
    const entry = byAddress.get(sender.address) ?? { name: sender.name, messages: [] };
    entry.messages.push(message);
    byAddress.set(sender.address, entry);
  }
  const result = [...byAddress.entries()].map(([address, entry]) => {
    const messageIds = new Set(entry.messages.map((message) => message.id));
    const topics = [...new Set(entry.messages.map((message) => message.topic as MailTopic | null))];
    const covering = topics.map((topic) => matchRule(rules, address, topic)).filter((rule): rule is NonNullable<typeof rule> => !!rule) as SenderRuleRow[];
    return {
      address,
      name: entry.name,
      domain: organizationalDomain(domainOf(address)),
      count: entry.messages.length,
      last_received_at: entry.messages[0].received_at,
      kinds: tally(entry.messages.map((message) => message.kind)),
      topics: tally(entry.messages.map((message) => message.topic)),
      sort_actions: tally(entry.messages.map((message) => message.sort_action)),
      outcomes: tally(entry.messages.map((message) => latestOutcome.get(message.id)?.outcome)),
      task_count: new Set(links.filter((link) => messageIds.has(link.message_id)).map((link) => link.task_id)).size,
      rules: [...new Map(covering.map((rule) => [rule.id, { id: rule.id, label: describeRule(rule), action: rule.action, source: rule.source }])).values()],
    };
  }).sort((a, b) => b.count - a.count || b.last_received_at.localeCompare(a.last_received_at)).slice(0, 200);
  return success({ days, senders: result });
}, { permission: 'inbound_email.read' });
