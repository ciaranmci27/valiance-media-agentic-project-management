import type { InboxTab, InboxTabCounts, MessageStatus, ThreadState, TriageOutcome, TrustLevel } from './inbox-types';
import { INBOX_TABS } from './inbox-types';

/**
 * How a thread reads in the Inbox, from its messages. Pure, so the session
 * routes and demo mode answer the same way. A message counts toward:
 * - Needs you: the agent (or an untrusted sender) put it at needs_ciaran.
 * - Needs reply: its latest triage drafted a reply and nobody has marked it
 *   handled yet (reviewed_at). A message sent back to the agent waits as New.
 * - New: the agent has not triaged it yet.
 * A thread whose every message was filtered as auto-mail is Ignored; the rest
 * are Handled.
 */

export interface MessageState {
  status: MessageStatus;
  reviewed_at: string | null;
  outcome: TriageOutcome | null;
  urgent: boolean;
  trust: TrustLevel;
}

export interface ThreadFlags {
  state: ThreadState;
  needs_you: boolean;
  needs_reply: boolean;
  has_new: boolean;
  urgent: boolean;
  untrusted: boolean;
}

export function messageNeedsReply(message: MessageState): boolean {
  return message.outcome === 'needs_reply'
    && !message.reviewed_at
    && message.status !== 'new'
    && message.status !== 'ignored';
}

export function threadFlags(messages: readonly MessageState[]): ThreadFlags {
  const needsYou = messages.some((message) => message.status === 'needs_ciaran');
  const needsReply = messages.some(messageNeedsReply);
  const hasNew = messages.some((message) => message.status === 'new');
  const allIgnored = messages.length > 0 && messages.every((message) => message.status === 'ignored');
  const state: ThreadState = needsYou ? 'needs_you' : hasNew ? 'new' : needsReply ? 'needs_reply' : allIgnored ? 'ignored' : 'handled';
  return {
    state,
    needs_you: needsYou,
    needs_reply: needsReply,
    has_new: hasNew,
    // Urgent only while it waits on a person.
    urgent: messages.some((message) => message.urgent && (message.status === 'needs_ciaran' || messageNeedsReply(message))),
    untrusted: messages.some((message) => message.trust === 'untrusted'),
  };
}

export function threadInTab(flags: ThreadFlags, projectId: string | null, tab: InboxTab): boolean {
  switch (tab) {
    case 'all': return true;
    case 'needs_you': return flags.needs_you;
    case 'needs_reply': return flags.needs_reply;
    case 'new': return flags.has_new;
    case 'handled': return flags.state === 'handled';
    case 'ignored': return flags.state === 'ignored';
    // Auto-mail is noise, not a mapping gap.
    case 'unassigned': return !projectId && flags.state !== 'ignored';
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

/** Every word of the query appears somewhere in the haystack (case-insensitive). */
export function matchesSearch(query: string, haystack: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.filter(Boolean).join(' \u0001 ').toLowerCase();
  return words.every((word) => text.includes(word));
}

/** A one-line preview of a message body. */
export function snippetOf(text: string | null | undefined, limit = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

export function isInboxTab(value: string | null | undefined): value is InboxTab {
  return !!value && (INBOX_TABS as readonly string[]).includes(value);
}
