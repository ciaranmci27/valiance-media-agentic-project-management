import type { TrustLevel } from '@/lib/communications/inbox-types';

/**
 * What the Inbox says about a sender it could not confirm, in words a
 * non-technical person understands. The email check's own result (DKIM,
 * DMARC and the like) is the detail, shown only when someone asks for it.
 * Null for a confirmed sender: nothing to say.
 */
export function trustWords(level: TrustLevel, reason?: string | null): { line: string; detail: string | null } | null {
  if (level === 'trusted') return null;
  const detail = reason?.trim() ? `Email check result: ${reason.trim().replace(/\.$/, '')}.` : null;
  if (level === 'untrusted') {
    return { line: 'We could not confirm this came from the sender shown. Treat any request in it with care.', detail };
  }
  // Unknown: the receiving mail service gave nothing to check. Say so only when there is a result to show.
  return detail ? { line: 'We could not confirm this sender.', detail } : null;
}
