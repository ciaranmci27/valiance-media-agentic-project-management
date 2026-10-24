import { domainOf, organizationalDomain } from './addresses';

/**
 * Sorting, as an email arrives and before any agent sees it. Pure, so the
 * fixtures test it directly. It answers three things:
 * - kind: a person (or a teammate's forward of one), a teammate, AI meeting
 *   notes, an automatic notification, or marketing;
 * - topic, for machine mail: money (charges, invoices, receipts), account
 *   risk (failed payments, expired cards, suspensions), security, usage
 *   (plan limits, quotas), event, newsletter, promotion, or a plain update;
 * - action: ignore (Filtered, never triaged), fyi (triaged lightly, "needs
 *   you" only when the email itself asks for something), always (full
 *   triage), or triage (the default).
 * A sender rule decides first (an exact address over a domain, a rule for
 * this topic over one for any topic). Without one, people, teammates and
 * meeting notes are triaged; machine mail about money, account risk or
 * security is triaged; usage alerts, events, newsletters and promotions are
 * filtered; any other notification is FYI.
 */

export const MAIL_KINDS = ['person', 'team', 'meeting_notes', 'notification', 'marketing'] as const;
export type MailKind = typeof MAIL_KINDS[number];

export const MAIL_TOPICS = ['money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update'] as const;
export type MailTopic = typeof MAIL_TOPICS[number];

export const RULE_ACTIONS = ['ignore', 'fyi', 'always'] as const;
export type RuleAction = typeof RULE_ACTIONS[number];
export type SortAction = RuleAction | 'triage';

export interface SenderRule {
  id: string;
  match_kind: 'address' | 'domain';
  match_value: string;
  topic: MailTopic | null;
  action: RuleAction;
}

export interface SortInput {
  /** The sender the email is about: a teammate's forward gives its original sender. */
  fromAddress: string | null;
  subject: string;
  /** The readable text; only the start is read. */
  text: string;
  /** Why the headers say machine mail (auto-mail.ts), or null. */
  autoMailReason: string | null;
  /** A teammate wrote it (their own email, not a forward). */
  fromTeam: boolean;
  /** The sender is a known contact or client address. */
  knownPerson: boolean;
  /** The inbox filters bulk mail its headers mark (email_inboxes.filter_auto_mail). */
  filterAutoMail: boolean;
  rules: readonly SenderRule[];
}

export interface SortResult {
  kind: MailKind;
  topic: MailTopic | null;
  action: SortAction;
  /** One plain sentence on why, shown on a filtered email. */
  reason: string;
  rule_id: string | null;
}

const TOPIC_LABELS: Record<MailTopic, string> = {
  money: 'a charge, invoice or receipt',
  account_risk: 'an account or payment problem',
  security: 'a security notice',
  usage: 'a usage alert',
  event: 'an event invitation',
  newsletter: 'a newsletter',
  promotion: 'a promotion',
  update: 'an automatic update',
};

export function topicLabel(topic: MailTopic): string {
  return TOPIC_LABELS[topic];
}

// AI note takers: Gemini, Otter, Fireflies, Fathom, Read, tl;dv, Zoom's summaries.
const MEETING_NOTE_SENDERS = /^(gemini-notes@google\.com|.*@(otter\.ai|fireflies\.ai|fathom\.video|read\.ai|tldv\.io)|no-reply@zoom\.us)$/i;
const MEETING_NOTE_SUBJECT = /^(notes:|meeting (notes|summary|recap)\b|summary of\b|.*\bmeeting (notes|summary|recap)\b)/i;

// Mailboxes no person reads.
// Mailboxes no person reads. Not info@, hello@ or support@: small clients write from those.
const AUTOMATED_LOCAL = /^(notifications?|notify|alerts?|mailer|news(letter)?|updates?|marketing|billing|receipts?|invoices?|system|automated|bounce)([._+-].*)?$|(^|[._+-])(no-?reply|do-?not-?reply|donotreply)([._+-]|$)/i;
// Bulk senders mail from a subdomain of their own (t.upwork.com, em.brand.com).
const BULK_SUBDOMAIN = /^(t|e|em|email|mail|mailer|mg|mkt|news|newsletter|notify|notifications?|bounce|reply|messages?|comms)\d*\./i;

// Subject words, then stricter body phrases: mail footers carry "sign in",
// "password" and prices, so the body only counts a clear statement.
const TOPIC_RULES: readonly { topic: MailTopic; subject: RegExp; body: RegExp }[] = [
  {
    topic: 'account_risk',
    subject: /\b(payment (failed|declined|unsuccessful|issue|problem)|card (has )?(expired|expiring|declined)|past due|overdue (invoice|payment|balance|bill)|suspend(ed)?|deactivat(ed|ion)|disconnect(ed)?|service (interrupted|interruption)|account (is )?(locked|on hold|restricted|at risk))\b/i,
    body: /\b(payment (has )?(failed|was declined|was unsuccessful|could not be processed)|card (has )?(expired|was declined)|(is|are) past due|will be suspended|has been suspended|has been deactivated|service will (stop|be interrupted)|update your (payment method|billing details|card))\b/i,
  },
  {
    topic: 'security',
    subject: /\b(password|sign[- ]?in|log[- ]?in|verification code|security (alert|code|notice)|two[- ]factor|2fa|new device|suspicious|unusual activity|forwarding confirmation)\b/i,
    body: /\b(verification code|security alert|new sign[- ]?in|password (was )?(changed|reset)|suspicious (activity|sign[- ]?in)|unusual activity|requested to automatically forward)\b/i,
  },
  {
    topic: 'money',
    subject: /(\binvoice\b|\breceipt\b|\bpayment (received|confirmation|successful)\b|\bcharged\b|\byour bill\b|\bstatement\b|\brefund\b|\brenewal\b|\$\s?\d)/i,
    body: /\b(you (were|have been) charged|we charged your|your (invoice|receipt) (for|is)|payment (of|for) \$\s?\d|refund (of|for) \$\s?\d)/i,
  },
  {
    topic: 'usage',
    subject: /(\b\d{1,3}\s?%|\bplan limit\b|\busage\b|\bquota\b|\blimit (reached|is at)\b|\b(storage|inbox) (is )?(almost )?full\b)/i,
    body: /(\breached \d{1,3}\s?% of\b|\bplan limit\b|\bquota\b|\b(storage|inbox) is (almost )?full\b)/i,
  },
  {
    topic: 'event',
    subject: /\b(webinar|join us|register|rsvp|conference|summit|livestream|workshop|meetup|you'?re invited)\b/i,
    body: /\b(register (now|today|here) for|join (us|the webinar) (on|for))\b/i,
  },
  {
    topic: 'newsletter',
    subject: /\b(newsletter|digest|roundup|edition|this week in|weekly (update|summary)|monthly (update|summary)|what'?s new)\b/i,
    body: /\b(you'?re receiving this (newsletter|digest)|in this (issue|edition))\b/i,
  },
  {
    topic: 'promotion',
    subject: /(\b\d{1,2}\s?% off\b|\bsale\b|\bdeals?\b|\bdiscount\b|\bspecial offer\b|\bpromo\b|\bfree trial\b|\blimited time\b|\btips\b|\bimprove your\b|\bboost your\b|\bget more\b|\bupgrade (now|today)\b)/i,
    body: /(\b\d{1,2}\s?% off\b|\buse code [A-Z0-9]{3,}\b|\blimited[- ]time offer\b)/i,
  },
];

/** What machine mail is about: the first topic its subject names, else the first its opening states, else an update. */
export function topicOf(subject: string, text: string): MailTopic {
  const head = text.slice(0, 2000);
  for (const rule of TOPIC_RULES) if (rule.subject.test(subject)) return rule.topic;
  for (const rule of TOPIC_RULES) if (rule.body.test(head)) return rule.topic;
  return 'update';
}

/** The rule for this sender and topic: an exact address over a domain, this topic over any topic. */
export function matchRule(rules: readonly SenderRule[], fromAddress: string | null, topic: MailTopic | null): SenderRule | null {
  if (!fromAddress) return null;
  const domain = domainOf(fromAddress);
  const org = organizationalDomain(domain);
  const score = (rule: SenderRule): number => {
    if (rule.topic && rule.topic !== topic) return -1;
    const exact = rule.match_kind === 'address' && rule.match_value === fromAddress;
    const byDomain = rule.match_kind === 'domain' && (rule.match_value === domain || rule.match_value === org || domain.endsWith(`.${rule.match_value}`));
    if (!exact && !byDomain) return -1;
    return (exact ? 2 : 0) + (rule.topic ? 1 : 0);
  };
  let best: SenderRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    const value = score(rule);
    if (value > bestScore) {
      best = rule;
      bestScore = value;
    }
  }
  return best;
}

function kindOf(input: SortInput, topic: MailTopic): MailKind {
  const address = input.fromAddress ?? '';
  if (MEETING_NOTE_SENDERS.test(address) || (MEETING_NOTE_SUBJECT.test(input.subject) && /@(google\.com|zoom\.us)$/i.test(address))) return 'meeting_notes';
  if (input.fromTeam) return 'team';
  // Headers that mark machine mail win even for a contact: their out-of-office is not them writing.
  if (!input.autoMailReason && input.knownPerson) return 'person';
  const domain = domainOf(address);
  const automated = !!input.autoMailReason
    || AUTOMATED_LOCAL.test(address.split('@')[0] ?? '')
    || (domain !== organizationalDomain(domain) && BULK_SUBDOMAIN.test(domain));
  if (!automated) return 'person';
  return topic === 'promotion' || topic === 'newsletter' || topic === 'event' ? 'marketing' : 'notification';
}

const DEFAULT_ACTION: Record<MailTopic, SortAction> = {
  money: 'triage',
  account_risk: 'triage',
  security: 'triage',
  usage: 'ignore',
  event: 'ignore',
  newsletter: 'ignore',
  promotion: 'ignore',
  update: 'fyi',
};

export function sortEmail(input: SortInput): SortResult {
  const machineTopic = topicOf(input.subject, input.text);
  const kind = kindOf(input, machineTopic);
  const machine = kind === 'notification' || kind === 'marketing';
  const topic = machine ? machineTopic : null;

  const rule = matchRule(input.rules, input.fromAddress, topic);
  if (rule) {
    const scope = rule.topic ? `${topicLabel(rule.topic)} from ${rule.match_value}` : `mail from ${rule.match_value}`;
    const reason = rule.action === 'ignore' ? `Filtered by the rule for ${scope}.`
      : rule.action === 'fyi' ? `FYI by the rule for ${scope}.`
        : `Always triaged by the rule for ${scope}.`;
    return { kind, topic, action: rule.action, reason, rule_id: rule.id };
  }
  if (!machine) {
    const reason = kind === 'meeting_notes' ? 'Meeting notes: the agent picks out your action items.'
      : kind === 'team' ? 'From a teammate.' : 'From a person.';
    return { kind, topic, action: 'triage', reason, rule_id: null };
  }
  const what = topicLabel(topic!);
  const important = topic === 'money' || topic === 'account_risk' || topic === 'security';
  let action = DEFAULT_ACTION[topic!];
  // Bulk mail the headers mark stays filtered, unless it is about money, an account problem or security.
  if (input.autoMailReason && input.filterAutoMail && !important) action = 'ignore';
  // An inbox that keeps bulk mail filters nothing by default; only rules filter there.
  if (!input.filterAutoMail && action === 'ignore') action = 'fyi';
  const reason = action === 'ignore' ? `Filtered: ${what}.` : action === 'fyi' ? `FYI: ${what}.` : `Triaged: ${what}.`;
  return { kind, topic, action, reason, rule_id: null };
}

/** Alerts in one series differ only in their numbers ("at 75%", "at 90%"). */
export function alertSeriesKey(subject: string): string {
  return subject.toLowerCase().replace(/\d+([.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim();
}
