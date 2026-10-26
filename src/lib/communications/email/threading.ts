/**
 * Which thread a new message joins, decided from facts the caller loads
 * (all within the message's own inbox):
 * 1. a thread holding a message whose Message-ID appears in this message's
 *    In-Reply-To or References;
 * 2. else a thread with the same normalized subject, active within the
 *    window, that shares a participant (inbox addresses excluded by the
 *    caller, or every message would share one);
 * 3. else a new thread.
 */

export const THREAD_SUBJECT_WINDOW_DAYS = 30;

export interface ReferencedMessage {
  thread_id: string;
  received_at: string;
}

export interface SubjectThread {
  thread_id: string;
  subject_normalized: string;
  last_message_at: string;
  participants: readonly string[];
}

export type ThreadChoice =
  | { kind: 'existing'; thread_id: string; reason: 'references' | 'subject' }
  | { kind: 'new' };

/** Message-IDs from In-Reply-To and References, unbracketed, deduplicated, newest last, capped. */
export function referencedIds(inReplyTo: readonly string[], references: readonly string[], cap = 100): string[] {
  const all = [...references, ...inReplyTo].map(normalizeMessageId).filter((id): id is string => !!id);
  return [...new Set(all)].slice(-cap);
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  const id = (value ?? '').trim().replace(/^<+|>+$/g, '').trim();
  return id.length > 0 && id.length <= 998 && !/\s/.test(id) ? id : null;
}

export function chooseThread(input: {
  referenced: readonly ReferencedMessage[];
  subjectNormalized: string;
  subjectThreads: readonly SubjectThread[];
  participants: readonly string[];
  receivedAt: string;
  windowDays?: number;
}): ThreadChoice {
  if (input.referenced.length > 0) {
    const newest = [...input.referenced].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))[0];
    return { kind: 'existing', thread_id: newest.thread_id, reason: 'references' };
  }
  if (!input.subjectNormalized) return { kind: 'new' };
  const windowMs = (input.windowDays ?? THREAD_SUBJECT_WINDOW_DAYS) * 86_400_000;
  const received = Date.parse(input.receivedAt);
  const mine = new Set(input.participants.map((address) => address.toLowerCase()));
  const match = input.subjectThreads
    .filter((thread) => thread.subject_normalized === input.subjectNormalized)
    .filter((thread) => Math.abs(received - Date.parse(thread.last_message_at)) <= windowMs)
    .filter((thread) => thread.participants.some((address) => mine.has(address.toLowerCase())))
    .sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at))[0];
  return match ? { kind: 'existing', thread_id: match.thread_id, reason: 'subject' } : { kind: 'new' };
}
