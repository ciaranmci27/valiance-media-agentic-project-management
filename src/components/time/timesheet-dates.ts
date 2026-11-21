import type { TimeEntry } from '@/lib/types';
import { workedSegments } from '@/lib/time-entry-utils';

export { workedSegments };
/**
 * Calendar helpers for the timesheet, in the browser's local time: the same
 * day keys `getWorkedHoursByDay` produces. Weeks start on Monday.
 */

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The same wall-clock time `days` later; DST-safe (setDate, not milliseconds). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Local midnight of the Monday on or before `date`. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const offset = (start.getDay() + 6) % 7; // Monday 0 .. Sunday 6
  start.setDate(start.getDate() - offset);
  return start;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** "Nov 17", or "Nov 17, 2025" outside this year. */
export function fmtShortDate(date: Date): string {
  const base = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return date.getFullYear() === new Date().getFullYear() ? base : `${base}, ${date.getFullYear()}`;
}

/** "Nov 17 to 23", "Dec 29 to Jan 4", with the year when it is not this one. */
export function fmtWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const startMonth = weekStart.toLocaleDateString('en-US', { month: 'short' });
  const endMonth = end.toLocaleDateString('en-US', { month: 'short' });
  const range = startMonth === endMonth
    ? `${startMonth} ${weekStart.getDate()} to ${end.getDate()}`
    : `${startMonth} ${weekStart.getDate()} to ${endMonth} ${end.getDate()}`;
  return end.getFullYear() === new Date().getFullYear() ? range : `${range}, ${end.getFullYear()}`;
}

/** "6.5h", "6h": the app's one hours format (src/lib/format.ts). */
export { formatHours as fmtHours } from '@/lib/format';

// ── Hours in a person's own timezone ─────────────────────────────────────────


const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" of an instant in a timezone (an unknown zone falls back to UTC). */
export function dayKeyInZone(ms: number, timeZone: string): string {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(ms));
}

/**
 * Worked hours by day in `timeZone`, the way a person's profile counts them
 * (their saved timezone, UTC when none). Segments are split at that zone's
 * midnights in 15-minute steps, which lands exactly on every real offset.
 */
export function workedHoursByDayInZone(entry: TimeEntry, now: number, timeZone: string): Map<string, number> {
  const result = new Map<string, number>();
  const STEP = 15 * 60_000;
  for (const segment of workedSegments(entry)) {
    const start = new Date(segment.start).getTime();
    const end = segment.end ? new Date(segment.end).getTime() : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    let cursor = start;
    while (cursor < end) {
      const key = dayKeyInZone(cursor, timeZone);
      // Advance to the next quarter-hour mark, then on while the day holds.
      let next = Math.min(end, Math.floor(cursor / STEP) * STEP + STEP);
      while (next < end && dayKeyInZone(next, timeZone) === key) next = Math.min(end, next + STEP);
      // `next` may sit on the first moment of the next day: count up to it.
      result.set(key, (result.get(key) ?? 0) + (next - cursor) / 3_600_000);
      cursor = next;
    }
  }
  return result;
}

/** Today's day key and the last 30 day keys (today included) in a timezone. */
export function recentDayKeysInZone(now: number, timeZone: string, count = 30): string[] {
  const keys = new Set<string>();
  // Step back in 6-hour moves so no calendar day in the zone is skipped.
  for (let t = now; keys.size < count && t > now - (count + 2) * 86_400_000; t -= 6 * 3_600_000) keys.add(dayKeyInZone(t, timeZone));
  return [...keys].slice(0, count);
}
