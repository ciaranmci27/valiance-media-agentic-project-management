import { relativeTime } from '@/components/settings/EmailConnectChecklist';
import type { InboxSettings } from '@/lib/communications/inbox-types';

/**
 * One line on whether an inbox gets mail, shared by the Email overview and
 * the handler page: on (mail has come in), waiting (nothing yet), off, or a
 * last error that no email has come through since.
 */
export interface InboxStatus {
  tone: 'on' | 'waiting' | 'off' | 'error';
  text: string;
}

/** The inbox's last error, while no email has arrived since it. */
export function currentError(inbox: InboxSettings): string | null {
  if (!inbox.last_error) return null;
  if (inbox.last_error_at && inbox.last_received_at && inbox.last_received_at > inbox.last_error_at) return null;
  return inbox.last_error;
}

export function inboxStatus(inbox: InboxSettings): InboxStatus {
  if (!inbox.enabled) return { tone: 'off', text: 'Off. Mail sent to it is dropped, not queued.' };
  if (inbox.last_received_at) return { tone: 'on', text: `Connected, last email ${relativeTime(inbox.last_received_at)}` };
  if (inbox.verified_at) return { tone: 'on', text: 'Connected, no email yet' };
  return { tone: 'waiting', text: 'Waiting for the first email' };
}

/** Worst first: mail dropped, then a failure, then nothing arrived yet. */
const SEVERITY: Record<InboxStatus['tone'], number> = { off: 3, error: 2, waiting: 1, on: 0 };

function toneOf(inbox: InboxSettings): InboxStatus['tone'] {
  if (!inbox.enabled) return 'off';
  if (currentError(inbox)) return 'error';
  return inboxStatus(inbox).tone;
}

/**
 * The worst status across every inbox, for the overview: which inbox it is
 * when there are several, or a count when several share it.
 */
export function worstStatus(inboxes: InboxSettings[]): InboxStatus {
  if (inboxes.length === 1) {
    const [inbox] = inboxes;
    const tone = toneOf(inbox);
    return tone === 'error' ? { tone, text: `Had an error ${relativeTime(inbox.last_error_at ?? inbox.created_at)}` } : inboxStatus(inbox);
  }
  const worst = Math.max(...inboxes.map((inbox) => SEVERITY[toneOf(inbox)]));
  const tone = (Object.keys(SEVERITY) as InboxStatus['tone'][]).find((key) => SEVERITY[key] === worst) ?? 'on';
  const hit = inboxes.filter((inbox) => toneOf(inbox) === tone);
  const who = hit.length === 1 ? hit[0].name : `${hit.length} inboxes`;
  const are = hit.length === 1 ? 'is' : 'are';
  if (tone === 'off') return { tone, text: `${who} ${are} off, so mail sent there is dropped` };
  if (tone === 'error') return { tone, text: hit.length === 1 ? `${who} had an error ${relativeTime(hit[0].last_error_at ?? hit[0].created_at)}` : `${who} had errors` };
  if (tone === 'waiting') return { tone, text: `${who} ${are} waiting for the first email` };
  const latest = inboxes.map((inbox) => inbox.last_received_at).filter((at): at is string => !!at).sort().pop();
  return { tone, text: latest ? `All connected, last email ${relativeTime(latest)}` : 'All connected, no email yet' };
}

/** The dot beside a status line, in the colors the connect checklist uses. */
export const STATUS_DOT: Record<InboxStatus['tone'], string> = {
  on: 'bg-emerald-500',
  waiting: 'bg-zinc-400 motion-safe:animate-pulse',
  off: 'bg-zinc-500',
  error: 'bg-red-400',
};

/** True while an enabled inbox waits for its first email (the page polls). */
export const isWaiting = (inbox: InboxSettings) => inbox.enabled && !inbox.verified_at && !inbox.last_received_at;
