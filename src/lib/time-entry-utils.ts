/**
 * Shared helpers for reasoning about time entries, including pause/resume state
 * via the segments array.
 *
 * State machine (derived from end_time + segments):
 *   - Running:  end_time IS NULL AND last segment's end IS NULL
 *   - Paused:   end_time IS NULL AND last segment's end IS NOT NULL
 *   - Stopped:  end_time IS NOT NULL
 */

import { TimeEntry, TimeSegment } from './types';

/** True if the entry has an actively-ticking open segment. */
export function isRunning(entry: TimeEntry): boolean {
  if (entry.end_time !== null) return false;
  const last = entry.segments[entry.segments.length - 1];
  return !!last && last.end === null;
}

/** True if the entry is unfinalized but has no open segment (i.e., paused). */
export function isPaused(entry: TimeEntry): boolean {
  if (entry.end_time !== null) return false;
  const last = entry.segments[entry.segments.length - 1];
  return !!last && last.end !== null;
}

/**
 * Total worked time across all segments. For an actively running segment
 * (end: null), uses `now` as the virtual end so live timers tick.
 */
export function getWorkedMs(entry: TimeEntry, now: number = Date.now()): number {
  if (!entry.segments || entry.segments.length === 0) {
    // Backwards-compat fallback for rows that haven't been backfilled.
    if (!entry.end_time) return 0;
    return Math.max(0, new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime());
  }
  let total = 0;
  for (const seg of entry.segments) {
    const startMs = new Date(seg.start).getTime();
    const endMs = seg.end ? new Date(seg.end).getTime() : now;
    total += Math.max(0, endMs - startMs);
  }
  return total;
}

/** Total worked time in decimal hours. */
export function getWorkedHours(entry: TimeEntry, now: number = Date.now()): number {
  return getWorkedMs(entry, now) / 3_600_000;
}

/**
 * Worked hours grouped by local calendar day (YYYY-MM-DD). A session that
 * crosses midnight credits each day for its actual share of the time worked
 * (e.g. 8pm to 1am produces 4h on the start day and 1h on the next day).
 *
 * Splits at local-midnight boundaries using `setDate(d + 1)`, which is DST-safe:
 * the millisecond delta inside each fragment uses real (UTC) time, so on the
 * spring-forward day a 1am to 5am session correctly registers as 3 hours, not 4.
 *
 * Paused gaps don't count (uses segments). An open final segment ticks against
 * `now`, matching `getWorkedHours`.
 */
export function getWorkedHoursByDay(entry: TimeEntry, now: number = Date.now()): Map<string, number> {
  const result = new Map<string, number>();
  const segments: TimeSegment[] = entry.segments?.length
    ? entry.segments
    : entry.end_time
      ? [{ start: entry.start_time, end: entry.end_time }]
      : [];

  for (const seg of segments) {
    const startMs = new Date(seg.start).getTime();
    const endMs = seg.end ? new Date(seg.end).getTime() : now;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    let cursor = startMs;
    while (cursor < endMs) {
      const cursorDate = new Date(cursor);
      const nextMidnight = new Date(cursorDate);
      nextMidnight.setHours(0, 0, 0, 0);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      const fragmentEnd = Math.min(endMs, nextMidnight.getTime());
      const dayKey =
        `${cursorDate.getFullYear()}-` +
        `${String(cursorDate.getMonth() + 1).padStart(2, '0')}-` +
        `${String(cursorDate.getDate()).padStart(2, '0')}`;
      const hours = (fragmentEnd - cursor) / 3_600_000;
      result.set(dayKey, (result.get(dayKey) ?? 0) + hours);
      cursor = fragmentEnd;
    }
  }
  return result;
}

/**
 * Start-of-today epoch (in ms) in the given IANA timezone. Used for detecting
 * paused entries that crossed a day boundary and should be auto-finalized.
 *
 * Falls back to the browser's local timezone when `timezone` is omitted.
 *
 * Strategy: determine the calendar date in the target timezone, then find the
 * UTC instant whose wall-clock time in that timezone is 00:00 on that date.
 * We derive the offset by formatting a UTC-midnight guess in the timezone and
 * measuring the delta, which stays correct across DST transitions (midnight
 * itself is never in the ambiguous DST window).
 */
export function startOfDayInTz(date: Date, timezone?: string): number {
  if (!timezone) {
    const local = new Date(date);
    local.setHours(0, 0, 0, 0);
    return local.getTime();
  }
  // Calendar date in the target timezone.
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const dget = (t: Intl.DateTimeFormatPartTypes) =>
    dateParts.find(p => p.type === t)?.value ?? '00';
  const y = dget('year'), mo = dget('month'), d = dget('day');

  // Guess: treat "y-mo-d 00:00:00" as UTC. This is wrong by the timezone's
  // offset, which we now compute.
  const guess = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(guess)) return date.getTime();

  // Format the guess in the target timezone. The difference between what tz
  // displays and the UTC interpretation is the offset we need to apply.
  const displayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guess));
  const pget = (t: Intl.DateTimeFormatPartTypes) => {
    const v = displayParts.find(p => p.type === t)?.value ?? '00';
    // Some engines report "24" for midnight under hour12:false.
    return v === '24' ? '00' : v;
  };
  const displayed = Date.parse(
    `${pget('year')}-${pget('month')}-${pget('day')}T${pget('hour')}:${pget('minute')}:${pget('second')}Z`,
  );
  if (Number.isNaN(displayed)) return date.getTime();

  // offset = guess - displayed, positive when tz is behind UTC.
  // UTC instant of local midnight = guess + offset.
  return guess + (guess - displayed);
}

/**
 * Returns entries that are paused on a previous calendar day and should be
 * auto-finalized before rendering. Accepts either a single timezone or a
 * per-entry resolver (for the store load path where each entry may belong
 * to a different team member).
 */
export function findStalePausedEntries(
  entries: TimeEntry[],
  timezone?: string | ((entry: TimeEntry) => string | undefined),
): TimeEntry[] {
  const now = new Date();
  const resolveTz: (entry: TimeEntry) => string | undefined =
    typeof timezone === 'function' ? timezone : () => timezone;
  return entries.filter(e => {
    if (e.end_time !== null) return false; // already finalized
    const last = e.segments[e.segments.length - 1];
    if (!last || last.end === null) return false; // actively running, not paused
    const tz = resolveTz(e);
    const todayStart = startOfDayInTz(now, tz);
    return new Date(last.end).getTime() < todayStart;
  });
}

/** Returns a new segments array with the last segment closed at `endIso`. */
export function closeOpenSegment(segments: TimeSegment[], endIso: string): TimeSegment[] {
  if (segments.length === 0) return segments;
  const last = segments[segments.length - 1];
  if (last.end !== null) return segments; // nothing to close
  return [...segments.slice(0, -1), { ...last, end: endIso }];
}

/** Returns a new segments array with a new open segment appended. */
export function appendOpenSegment(segments: TimeSegment[], startIso: string): TimeSegment[] {
  return [...segments, { start: startIso, end: null }];
}
