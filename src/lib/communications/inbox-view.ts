import type { InboxTab, InboxTabCounts, MessageStatus, ThreadState, TriageOutcome, TrustLevel } from './inbox-types';
import type { MailKind, MailTopic } from './sorting';
import type { TriageCategory } from './outreach';
import { INBOX_TABS } from './inbox-types';

/**
 * How a thread reads in the Inbox, from its messages. Pure, so the session
 * routes and demo mode answer the same way. A message counts toward:
 * - Needs you: the agent (or an untrusted sender) put it at needs_human.
 * - Needs reply: its latest triage drafted a reply and nobody has marked it
 *   handled yet (reviewed_at). A message sent back to the agent waits as New.
 * - New: the agent has not triaged it yet.
 * A thread whose every message was filtered as auto-mail is Ignored; the rest
 * are Handled.
 *
 * Apart from its state, a thread is an Update when it is only machine mail
 * (notifications, marketing) that asks nothing of a person: nothing needs
 * you or a reply, nothing urgent, and nothing about money, an account
 * problem or security. Updates stay out of the Inbox view, like Filtered.
 * Mail from before sorting (no kind) always counts as the Inbox.
 *
 * A thread is FYI when the agent read its latest email as needing nothing
 * (category fyi) and nothing waits on anyone; it is Codes when every email
 * in it is a one-time code. Filtered holds the rest of the filtered mail.
 */

export interface MessageState {
  status: MessageStatus;
  reviewed_at: string | null;
  outcome: TriageOutcome | null;
  urgent: boolean;
  trust: TrustLevel;
  /** How sorting saw it; absent or null for mail from before sorting. */
  kind?: MailKind | null;
  topic?: MailTopic | null;
  /** What the agent's latest triage read it as. */
  category?: TriageCategory | null;
}

export interface ThreadFlags {
  state: ThreadState;
  needs_you: boolean;
  needs_reply: boolean;
  has_new: boolean;
  urgent: boolean;
  untrusted: boolean;
  /** Only machine mail that asks nothing of anyone: the Updates view. */
  update: boolean;
  /** A conversation the agent read as needing nothing: the FYI view. */
  fyi: boolean;
  /** Only one-time codes: the Codes view. */
  code: boolean;
}

const ALWAYS_INBOX_TOPICS: readonly (MailTopic | null | undefined)[] = ['money', 'account_risk', 'security'];

export function messageNeedsReply(message: MessageState): boolean {
  return message.outcome === 'needs_reply'
    && !message.reviewed_at
    && message.status !== 'new'
    && message.status !== 'ignored';
}

/** Messages oldest first: FYI reads the latest one. */
export function threadFlags(messages: readonly MessageState[]): ThreadFlags {
  const needsYou = messages.some((message) => message.status === 'needs_human');
  const needsReply = messages.some(messageNeedsReply);
  const hasNew = messages.some((message) => message.status === 'new');
  const allIgnored = messages.length > 0 && messages.every((message) => message.status === 'ignored');
  const state: ThreadState = needsYou ? 'needs_you' : hasNew ? 'new' : needsReply ? 'needs_reply' : allIgnored ? 'ignored' : 'handled';
  const urgent = messages.some((message) => message.urgent && (message.status === 'needs_human' || messageNeedsReply(message)));
  const shown = messages.filter((message) => message.status !== 'ignored');
  const update = !needsYou && !needsReply && !urgent && shown.length > 0
    && shown.every((message) => (message.kind === 'notification' || message.kind === 'marketing') && !ALWAYS_INBOX_TOPICS.includes(message.topic));
  const fyi = !needsYou && !needsReply && !hasNew && !urgent && !update && shown.length > 0 && shown[shown.length - 1].category === 'fyi';
  return {
    state,
    needs_you: needsYou,
    needs_reply: needsReply,
    has_new: hasNew,
    // Urgent only while it waits on a person.
    urgent,
    untrusted: messages.some((message) => message.trust === 'untrusted'),
    update,
    fyi,
    code: messages.length > 0 && messages.every((message) => message.topic === 'code'),
  };
}

function inInbox(flags: ThreadFlags): boolean {
  return flags.state !== 'ignored' && !flags.update && !flags.fyi;
}

export function threadInTab(flags: ThreadFlags, projectId: string | null, tab: InboxTab): boolean {
  switch (tab) {
    // The Inbox is what a person should see: FYI, Updates, Codes and Filtered wait in their own views.
    case 'all': return inInbox(flags);
    case 'fyi': return flags.state !== 'ignored' && flags.fyi;
    case 'updates': return flags.state !== 'ignored' && flags.update;
    case 'codes': return flags.code;
    case 'ignored': return flags.state === 'ignored' && !flags.code;
    // What waits on someone shows wherever it lives.
    case 'needs_you': return flags.needs_you;
    case 'needs_reply': return flags.needs_reply;
    case 'new': return flags.has_new && !flags.code;
    case 'handled': return flags.state === 'handled' && inInbox(flags);
    // Auto-mail is noise, not a mapping gap.
    case 'unassigned': return !projectId && inInbox(flags);
  }
}

export function tabCounts(threads: readonly { flags: ThreadFlags; project_id: string | null }[]): InboxTabCounts {
  const counts = Object.fromEntries(INBOX_TABS.map((tab) => [tab, 0])) as InboxTabCounts;
  for (const thread of threads) {
    for (const tab of INBOX_TABS) if (threadInTab(thread.flags, thread.project_id, tab)) counts[tab]++;
  }
  return counts;
}

/** What the sidebar badge counts: threads waiting on a person. */
export function needsAttention(flags: ThreadFlags): boolean {
  return flags.needs_you || flags.needs_reply;
}

/**
 * How badly a thread needs a person: urgent (red), a decision only they can
 * make (amber), or a reply to send (neutral). Null when nothing waits.
 */
export type AttentionLevel = 'urgent' | 'decide' | 'reply';

export function attentionLevel(flags: ThreadFlags): AttentionLevel | null {
  if (flags.urgent) return 'urgent';
  if (flags.needs_you) return 'decide';
  if (flags.needs_reply) return 'reply';
  return null;
}

/** The sidebar badge: how many threads wait, by how badly. */
export interface InboxAttention {
  total: number;
  urgent: number;
  decide: number;
  reply: number;
}

export function attentionCounts(threads: readonly ThreadFlags[]): InboxAttention {
  const counts: InboxAttention = { total: 0, urgent: 0, decide: 0, reply: 0 };
  for (const flags of threads) {
    const level = attentionLevel(flags);
    if (!level) continue;
    counts.total++;
    counts[level]++;
  }
  return counts;
}

/** How long the newest one-time code stays pinned at the top of the Inbox. */
export const CODE_PIN_MINUTES = 10;

// "807155 is your verification code", "G-482913 is your Google verification code".
const CODE_IN_SUBJECT = /\b([A-Z]{1,3}-)?\d{4,8}\b/;
// "Your code is: 4KQ-92B", "verification code 448193".
const CODE_IN_TEXT = /\b(?:code|passcode|otp)\b(?:\s+is)?\s*:?\s*([A-Z0-9]{2,5}-?[A-Z0-9]{2,6})\b/i;

/** The code itself, from the subject or else the opening text; null when neither shows one. */
export function codeIn(subject: string, text: string | null | undefined): string | null {
  const fromSubject = subject.match(CODE_IN_SUBJECT)?.[0];
  if (fromSubject) return fromSubject;
  const fromText = (text ?? '').slice(0, 1000).match(CODE_IN_TEXT)?.[1];
  return fromText && /\d/.test(fromText) ? fromText : null;
}

/** Every word of the query appears somewhere in the haystack (case-insensitive). */
export function matchesSearch(query: string, haystack: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.filter(Boolean).join(' \u0001 ').toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * A one-line preview of a message body: no web links (tracking URLs would
 * fill it) and none of the invisible padding newsletters put after their
 * preview text.
 */
export function snippetOf(text: string | null | undefined, limit = 160): string {
  const flat = (text ?? '')
    .replace(/[(<[]?https?:\/\/[^\s<>()[\]]+[)>\]]?/gi, ' ')
    .replace(/[͏­​-‏⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

export function isInboxTab(value: string | null | undefined): value is InboxTab {
  return !!value && (INBOX_TABS as readonly string[]).includes(value);
}
