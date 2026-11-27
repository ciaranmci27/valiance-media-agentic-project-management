import { appLocale } from '@/lib/region/active';
import { appTimeZone, dayKeyIn, yearIn } from '@/lib/time-zone';

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
 *
 * Moments show in the person's profile time zone (lib/time-zone: their
 * profile zone, else the browser's); pass `timeZone` to say another. A
 * calendar date (YYYY-MM-DD) has no zone and reads the same everywhere.
 */

export type TimeInput = string | number | Date;

const toDate = (value: TimeInput): Date => (value instanceof Date ? value : new Date(value));
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "Nov 26", with the year when it is not this year (in the zone). A calendar date reads as that day. */
export function formatDay(value: TimeInput, now: Date = new Date(), timeZone: string = appTimeZone()): string {
  if (typeof value === 'string' && DATE_ONLY.test(value)) return formatCalendarDay(value, { now });
  const d = toDate(value);
  return d.toLocaleDateString(appLocale(), {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(yearIn(d, timeZone) === yearIn(now, timeZone) ? {} : { year: 'numeric' }),
  });
}

/** "Nov 26, 1:15 PM", with the year when it is not this year. */
export function formatDateTime(value: TimeInput, now: Date = new Date(), timeZone: string = appTimeZone()): string {
  const d = toDate(value);
  return d.toLocaleString(appLocale(), {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(yearIn(d, timeZone) === yearIn(now, timeZone) ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The time of day alone: "1:15 PM". */
export function formatTime(value: TimeInput, timeZone: string = appTimeZone()): string {
  return toDate(value).toLocaleTimeString(appLocale(), { timeZone, hour: 'numeric', minute: '2-digit' });
}

/**
 * A moment in the person's zone with the fields a screen names (a timeline's
 * "Thu, Nov 26, 2026, 1:15 PM", a run's "Nov 26, 1:15 PM"), for the few
 * places the formats above do not fit. Prefer those; never call
 * toLocaleString on a moment directly (it shows the browser's zone).
 */
export function formatInZone(value: TimeInput, fields: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }, timeZone: string = appTimeZone()): string {
  return toDate(value).toLocaleString(appLocale(), { ...fields, timeZone });
}

/** The whole moment, for a tooltip: "Thursday, November 26, 2026 at 1:15 PM". */
export function formatFull(value: TimeInput, timeZone: string = appTimeZone()): string {
  return toDate(value).toLocaleString(appLocale(), { dateStyle: 'full', timeStyle: 'short', timeZone });
}

/**
 * How long ago, the way Messages says it: "Just now", "5 min ago", "2 h ago"
 * while it is still today, "Yesterday", then the date. A time a little in
 * the future (clock skew) reads as just now.
 */
export function formatAgo(value: TimeInput, options: { now?: Date; midSentence?: boolean; timeZone?: string } = {}): string {
  const now = options.now ?? new Date();
  const zone = options.timeZone ?? appTimeZone();
  const then = toDate(value);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  const lower = (words: string) => (options.midSentence ? words.toLowerCase() : words);
  if (mins < 1) return lower('Just now');
  if (mins < 60) return `${mins} min ago`;
  // Today and yesterday are the person's days, in their zone.
  const day = dayKeyIn(then, zone);
  const today = dayKeyIn(now, zone);
  if (day === today) return `${Math.floor(mins / 60)} h ago`;
  if (day === previousDayKey(today)) return lower('Yesterday');
  return formatDay(then, now, zone);
}

/** The calendar day before a YYYY-MM-DD day. */
function previousDayKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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

/**
 * A calendar date (YYYY-MM-DD, such as a due date) as formatDay says it:
 * "Jan 10", or "Jan 1, 2027" when it is not this year; `weekday` adds the
 * day ("Fri, Jan 10"). A calendar date has no time zone, so it is the same
 * day for everyone. Anything else is read as a time and passed to formatDay.
 */
export function formatCalendarDay(date: string, options: { now?: Date; weekday?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return formatDay(date, options.now);
  const [, year, month, day] = match.map(Number);
  const now = options.now ?? new Date();
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(appLocale(), {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(options.weekday ? { weekday: 'short' } : {}),
    ...(year === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
