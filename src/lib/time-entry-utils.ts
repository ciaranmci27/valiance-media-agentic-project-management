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
  // A finalized entry stops the clock at its own end, never at 'now'. An
  // open segment on a stopped entry should not exist - every stop path closes
  // it, and an audit of production found none - but nothing in the database or
  // the API enforces that: validateEntryTiming explicitly permits a null
  // segment end and never cross-checks end_time. Were one to appear, this
  // function is what payroll and client billing both read, so the entry would
  // bill a little more every time anyone looked at it. Clamping costs nothing
  // and makes that unbounded case unreachable.
  const openEnd = entry.end_time ? new Date(entry.end_time).getTime() : now;
  let total = 0;
  for (const seg of entry.segments) {
    const startMs = new Date(seg.start).getTime();
    const endMs = seg.end ? new Date(seg.end).getTime() : openEnd;
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
 * Worked hours split by local hour-of-day (0–23) within a single calendar day.
 * Returns a 24-element array indexed by local hour. A session spanning hour
 * boundaries credits each hour for its actual share of the time worked, and
 * anything outside `dayKey` is ignored entirely.
 *
 * Paused gaps don't count (uses segments). An open final segment ticks against
 * `now`, matching `getWorkedHours` / `getWorkedHoursByDay`.
 */
export function getWorkedHoursByHour(
  entry: TimeEntry,
  dayKey: string,
  now: number = Date.now(),
): number[] {
  const result = new Array<number>(24).fill(0);
  const segments: TimeSegment[] = entry.segments?.length
    ? entry.segments
    : entry.end_time
      ? [{ start: entry.start_time, end: entry.end_time }]
      : [];

  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return result;
  const dayStartMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  // setDate handles month/year rollover and is DST-safe (next-midnight pattern).
  const dayEnd = new Date(y, m - 1, d, 0, 0, 0, 0);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const dayEndMs = dayEnd.getTime();

  for (const seg of segments) {
    const segStart = new Date(seg.start).getTime();
    const segEnd = seg.end ? new Date(seg.end).getTime() : now;
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) continue;

    const clipStart = Math.max(segStart, dayStartMs);
    const clipEnd = Math.min(segEnd, dayEndMs);
    if (clipEnd <= clipStart) continue;

    let cursor = clipStart;
    while (cursor < clipEnd) {
      const cursorDate = new Date(cursor);
      const hour = cursorDate.getHours();
      const nextHour = new Date(cursorDate);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      const fragmentEnd = Math.min(clipEnd, nextHour.getTime());
      result[hour] += (fragmentEnd - cursor) / 3_600_000;
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
 * Minimum age before a paused entry may be treated as stale. Crossing a
 * midnight alone is not enough: `team_members.timezone` defaults to 'UTC'
 * (with no settings UI to change it), and for anyone west of UTC that
 * midnight lands mid-evening local time, so a fresh pause straddling it
 * looked like "yesterday" and Resume finalized the session instead of
 * resuming it. The age floor also protects deliberate work-past-midnight
 * sessions (pause 11:55pm, resume 12:10am).
 */
export const MIN_STALE_PAUSE_MS = 4 * 3_600_000;

/**
 * True when a pause is old enough to auto-finalize instead of resume:
 * it ended on a previous calendar day in `timezone` AND is at least
 * MIN_STALE_PAUSE_MS old. Both conditions are required; see the constant's
 * doc for why midnight-crossing alone misfires.
 */
export function isStalePause(lastEndIso: string, timezone?: string, now: Date = new Date()): boolean {
  const lastEndMs = new Date(lastEndIso).getTime();
  if (!Number.isFinite(lastEndMs)) return false;
  if (now.getTime() - lastEndMs < MIN_STALE_PAUSE_MS) return false;
  return lastEndMs < startOfDayInTz(now, timezone);
}

/**
 * Returns entries that are stale-paused (see isStalePause) and should be
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
    return isStalePause(last.end, resolveTz(e), now);
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

/**
 * Re-derive an entry's segments when its overall start/end (or date) is edited.
 *
 * Editing the entry-level times of a PAUSED entry is genuinely ambiguous, and
 * the first version of this resolved the ambiguity by collapsing everything to
 * one segment spanning the new bounds. That silently billed straight through
 * every break: a real incident turned 5h04m of tracked work into 12h25m by
 * nudging an end time. The rule now is that no edit may invent worked time.
 *
 * What the fields mean for a multi-segment entry, and what each edit does:
 *
 *   - The date field moves the whole session. Every segment shifts by the same
 *     delta, so the pause structure arrives intact on the new day. (Clamping
 *     instead would strand interior segments on the old date, producing
 *     negative-duration and out-of-order segments.)
 *   - The start field adjusts where work BEGINS. Earlier extends the first
 *     segment; later truncates into it; far enough to clear a segment
 *     entirely drops it.
 *   - The end field is the mirror image for where work ENDS.
 *
 * Landing in a pause is the case that decides the whole design: dragging the
 * start into a gap drops the segments before it, and the next segment keeps
 * its own start rather than being stretched back to meet the typed time —
 * stretching would invent minutes nobody worked. The returned `start`/`end`
 * are therefore the bounds the segments actually justify, which may differ
 * from what was typed, and callers should persist those rather than the raw
 * input so the entry's bounds and its segments can never disagree.
 *
 * Output always satisfies the server's rules (`validateEntryTiming`):
 * non-empty, every end >= its start, and no overlaps — gaps are only ever
 * preserved or dropped, never closed.
 */
export function resegmentEntry(params: {
  segments: TimeSegment[];
  /** Original entry start, to measure the shift against. */
  previousStart: string;
  /** Newly typed bounds, in ms. */
  newStart: number;
  newEnd: number;
  /** True when the date field changed, which means "move the whole session". */
  dayShifted: boolean;
}): { segments: TimeSegment[]; start: number; end: number } {
  const { segments, previousStart, newStart, newEnd, dayShifted } = params;
  const collapsed = {
    segments: [{ start: new Date(newStart).toISOString(), end: new Date(newEnd).toISOString() }],
    start: newStart,
    end: newEnd,
  };
  // One segment (or none) carries no pause history worth protecting: its
  // bounds ARE the entry's, so the typed values are the whole truth.
  if (!segments || segments.length <= 1) return collapsed;

  // An open segment closes at the new end rather than being discarded.
  // Dropping it looks harmless and is not: with the running block gone, the
  // code below sees nothing after the last closed segment and stretches that
  // one across the whole remaining window - re-inventing the very hours this
  // function exists to protect (caught by the open-segment case in the
  // scenario matrix, which billed 10.92h for a 5.07h day). Sorting defends
  // against rows stored loosely.
  const ordered = segments
    .map((s) => ({ start: Date.parse(s.start), end: s.end === null ? newEnd : Date.parse(s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
  if (ordered.length <= 1) return collapsed;

  const shift = dayShifted ? newStart - Date.parse(previousStart) : 0;
  const moved = ordered.map((s) => ({ start: s.start + shift, end: s.end + shift }));

  // Keep only what the new window still covers. Strict comparisons so a
  // segment touching the boundary exactly is dropped rather than kept as a
  // zero-length sliver.
  const firstIndex = moved.findIndex((s) => s.end > newStart && s.start < newEnd);
  if (firstIndex === -1) return collapsed;
  const kept = moved.filter((s) => s.end > newStart && s.start < newEnd);

  // Front edge. Extending backwards is only honest when nothing was dropped
  // ahead of it — otherwise the typed start sits in a pause, and the first
  // surviving segment keeps its own start.
  const droppedFromFront = firstIndex > 0;
  const head = kept[0];
  if (newStart > head.start || !droppedFromFront) {
    head.start = Math.min(newStart, head.end);
  }
  // Back edge, mirrored.
  const droppedFromBack = kept.length + firstIndex < moved.length;
  const tail = kept[kept.length - 1];
  if (newEnd < tail.end || !droppedFromBack) {
    tail.end = Math.max(newEnd, tail.start);
  }

  return {
    segments: kept.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
    })),
    start: kept[0].start,
    end: kept[kept.length - 1].end,
  };
}
