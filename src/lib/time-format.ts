import { appLocale } from '@/lib/region/active';

/**
 * The one time format family (DESIGN.md Rule 11). Pure and client-safe.
 *
 *   formatAgo:      "Just now", "5 min ago", "2 h ago" (still today),
 *                   "Yesterday", "Nov 26", "Nov 26, 2025" (another year)
 *   formatDay:      "Nov 26", or "Nov 26, 2025" in another year
 *   formatDateTime: "Nov 26, 1:15 PM", or "Nov 26, 2025, 1:15 PM"
 *   formatFull:     "Thursday, November 26, 2026 at 1:15 PM", for a tooltip
 *   formatElapsed:  "under a minute", "16 min", "1 h 5 min", "3 days"
 *
 * Mid-sentence ("Updated just now", "Checked yesterday"), pass
 * `{ midSentence: true }` so the words go lower case and dates keep theirs.
 * Older helpers (task-times timeAgo, portal relativeTime, Settings
 * relativeTime and agoWords, analytics fmtWhen) are wrappers over these.
 */

export type TimeInput = string | number | Date;

const toDate = (value: TimeInput): Date => (value instanceof Date ? value : new Date(value));
const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Nov 26", with the year when it is not this year. */
export function formatDay(value: TimeInput, now: Date = new Date()): string {
  const d = toDate(value);
  return d.toLocaleDateString(appLocale(), {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "Nov 26, 1:15 PM", with the year when it is not this year. */
export function formatDateTime(value: TimeInput, now: Date = new Date()): string {
  const d = toDate(value);
  return d.toLocaleString(appLocale(), {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The whole moment, for a tooltip: "Thursday, November 26, 2026 at 1:15 PM". */
export function formatFull(value: TimeInput): string {
  return toDate(value).toLocaleString(appLocale(), { dateStyle: 'full', timeStyle: 'short' });
}

/**
 * How long ago, the way Messages says it: "Just now", "5 min ago", "2 h ago"
 * while it is still today, "Yesterday", then the date. A time a little in
 * the future (clock skew) reads as just now.
 */
export function formatAgo(value: TimeInput, options: { now?: Date; midSentence?: boolean } = {}): string {
  const now = options.now ?? new Date();
  const then = toDate(value);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  const lower = (words: string) => (options.midSentence ? words.toLowerCase() : words);
  if (mins < 1) return lower('Just now');
  if (mins < 60) return `${mins} min ago`;
  const today = startOfDay(now);
  if (then.getTime() >= today) return `${Math.floor(mins / 60)} h ago`;
  if (then.getTime() >= today - DAY) return lower('Yesterday');
  return formatDay(then, now);
}

/**
 * A length of time in words: "under a minute", "16 min", "1 h 5 min",
 * "3 days". Never "0s": under a minute is said in words.
 */
export function formatElapsed(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
