import { z } from 'zod';
import { calendarDate } from '@/lib/schemas/shared';
import { RUNNER, TEMPLATE_VALUE_MAX } from '@/lib/task-templates';

/**
 * Schedules: one scheduler for two kinds of recurring work.
 * - A template schedule runs a template on every date of its recurrence
 *   (the run's key dates are that date, plus an offset per key date).
 * - A task repeat makes the next copy of a task. The recurrence gives the
 *   copies' due dates. On schedule (the default), the next copy appears
 *   when the current one falls due, so there is always exactly one copy
 *   ahead; after done, it appears when the current one is completed, due on
 *   the next date of the recurrence after that day.
 *
 * Pure and shared by the server, the screens and the tests: dates are
 * calendar dates (YYYY-MM-DD) worked out in UTC arithmetic; a time zone
 * matters only for "today" and the instant a date starts (local midnight).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateString = calendarDate;
/** The dates a schedule takes (start, end, a repeated task's due date): this century, so every date it lists is a real one. */
export const SCHEDULE_FIRST_DATE = '2000-01-01';
export const SCHEDULE_LAST_DATE = '2099-12-31';
export const inScheduleRange = (date: string) => date >= SCHEDULE_FIRST_DATE && date <= SCHEDULE_LAST_DATE;
const scheduleDate = dateString.refine(inScheduleRange, 'Pick a date from 2000 to 2099');

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = typeof SCHEDULE_FREQUENCIES[number];
export const SCHEDULE_KINDS = ['template', 'task'] as const;
export type ScheduleKind = typeof SCHEDULE_KINDS[number];
export const SCHEDULE_STATUSES = ['active', 'paused', 'ended'] as const;
export type ScheduleStatus = typeof SCHEDULE_STATUSES[number];
/** A task repeat: schedule (the next copy when the current one falls due) or after_done (when it is completed). */
export const REPEAT_MODES = ['schedule', 'after_done'] as const;
export type RepeatMode = typeof REPEAT_MODES[number];
export const OCCURRENCE_STATUSES = ['running', 'created', 'skipped', 'failed'] as const;
export type OccurrenceStatus = typeof OCCURRENCE_STATUSES[number];
/** first, second, third, fourth or last (-1) weekday of the month. */
export const MONTH_WEEKS = [1, 2, 3, 4, -1] as const;
export type MonthWeek = typeof MONTH_WEEKS[number];

/** Most days, weeks or months between two dates of a recurrence. */
export const INTERVAL_MAX: Record<ScheduleFrequency, number> = { daily: 365, weekly: 52, monthly: 24 };
/** Built-in fill-ins a schedule fills on every run: the run's date and its month. */
export const BUILT_IN_FILLS = ['date', 'month'] as const;

/**
 * How often: every `interval` days, weeks (on `weekdays`, 0 Sunday to 6
 * Saturday) or months (on `month_day`, clamped to the month's last day, or
 * on the `month_week` `month_weekday`: the first Monday, the last Friday).
 */
export const recurrenceSchema = z.object({
  freq: z.enum(SCHEDULE_FREQUENCIES),
  interval: z.number().int().min(1).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  month_day: z.number().int().min(1).max(31).optional(),
  month_week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]).optional(),
  month_weekday: z.number().int().min(0).max(6).optional(),
}).strict().superRefine((rule, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (rule.interval > INTERVAL_MAX[rule.freq]) issue('interval', `Every ${INTERVAL_MAX[rule.freq]} ${unit(rule.freq, 2)} at most`);
  if (rule.freq === 'weekly' && !rule.weekdays?.length) issue('weekdays', 'Pick at least one day of the week (0 Sunday to 6 Saturday)');
  if (rule.freq !== 'weekly' && rule.weekdays) issue('weekdays', 'weekdays is for a weekly recurrence');
  if (rule.freq === 'monthly') {
    const byDay = rule.month_day !== undefined;
    const byWeekday = rule.month_week !== undefined || rule.month_weekday !== undefined;
    if (byDay === byWeekday) issue('month_day', 'Send month_day (1 to 31), or month_week and month_weekday (the first Monday), not both');
    if (byWeekday && (rule.month_week === undefined || rule.month_weekday === undefined)) issue('month_week', 'Send month_week (1 to 4, or -1 for the last) with month_weekday (0 Sunday to 6 Saturday)');
  } else if (rule.month_day !== undefined || rule.month_week !== undefined || rule.month_weekday !== undefined) {
    issue('month_day', 'month_day, month_week and month_weekday are for a monthly recurrence');
  }
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

const roleMap = z.record(z.string(), z.union([z.literal(RUNNER), z.string().regex(UUID, 'A role maps to a member id, "runner" or null'), z.null()]));
const values = z.record(z.string(), z.string().trim().max(TEMPLATE_VALUE_MAX, `A value is ${TEMPLATE_VALUE_MAX} characters at most`));
const offsets = z.record(z.string(), z.number().int().min(-365).max(365));
const zone = z.string().min(1).max(64).refine(isTimeZone, 'Use an IANA time zone, like Europe/London or America/New_York');

/** A schedule on a template: what each run takes, plus when. */
export const templateScheduleSchema = z.object({
  /** Where the runs go. Left out for a project's own template. */
  project_id: z.string().regex(UUID, 'project_id must be a uuid').optional(),
  recurrence: recurrenceSchema,
  /** IANA time zone the dates are in. Default: the workspace's. */
  timezone: zone.optional(),
  /** The first day it may run. Default: today, in its time zone. */
  start_date: scheduleDate.optional(),
  /** The last day it may run. Null: no end. */
  end_date: scheduleDate.nullable().optional(),
  /** One member per role, by role key ("runner" is whoever runs it: the schedule's runner). */
  roles: roleMap.default({}),
  /** A value per fill-in field; date and month are filled on each run. */
  values: values.default({}),
  /** Days from the run's date to each key date other than the first (default 0: the run's date). */
  key_date_offsets: offsets.default({}),
  create_initiative: z.boolean().default(false),
  /** Skip a run while the previous run still has a task not done. Default true. */
  skip_if_open: z.boolean().default(true),
}).strict();
export type TemplateScheduleInput = z.infer<typeof templateScheduleSchema>;

/** A change to a schedule: only what changes. status pauses (paused) or resumes (active) it. */
export const scheduleUpdateSchema = z.object({
  project_id: z.string().regex(UUID, 'project_id must be a uuid').optional(),
  recurrence: recurrenceSchema.optional(),
  timezone: zone.optional(),
  start_date: scheduleDate.optional(),
  end_date: scheduleDate.nullable().optional(),
  roles: roleMap.optional(),
  values: values.optional(),
  key_date_offsets: offsets.optional(),
  create_initiative: z.boolean().optional(),
  skip_if_open: z.boolean().optional(),
  mode: z.enum(REPEAT_MODES).optional(),
  status: z.enum(['active', 'paused']).optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change');
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateSchema>;

/** A task's repeat. Its copies are due on the recurrence's dates, counted from the task's due date. */
export const taskRepeatSchema = z.object({
  recurrence: recurrenceSchema,
  /** schedule (default): the next copy appears when this one falls due. after_done: when this one is completed. */
  mode: z.enum(REPEAT_MODES).default('schedule'),
  timezone: zone.optional(),
  /** No copy is due after this day. Null: no end. */
  end_date: scheduleDate.nullable().optional(),
}).strict();
export type TaskRepeatInput = z.infer<typeof taskRepeatSchema>;

// ── Calendar dates ──────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

const dayNumber = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthIndex = (date: string) => {
  const [y, m] = parts(date);
  return y * 12 + (m - 1);
};
const fromMonth = (index: number, day: number) => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** Days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** 0 Sunday to 6 Saturday. */
export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

/** The Monday of a date's week, as a day number (weeks run Monday to Sunday). */
const mondayOf = (date: string) => dayNumber(date) - ((weekdayOf(date) + 6) % 7);

/** The date a monthly recurrence falls on in a month (by its index), or null. */
function monthlyDate(rule: Recurrence, index: number): string | null {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const length = daysInMonth(year, month);
  if (rule.month_day !== undefined) return fromMonth(index, Math.min(rule.month_day, length));
  if (rule.month_week === undefined || rule.month_weekday === undefined) return null;
  const firstWeekday = weekdayOf(fromMonth(index, 1));
  const first = 1 + ((rule.month_weekday - firstWeekday + 7) % 7);
  if (rule.month_week > 0) return fromMonth(index, first + (rule.month_week - 1) * 7);
  let last = first;
  while (last + 7 <= length) last += 7;
  return fromMonth(index, last);
}

/** Whether the recurrence, counted from start, falls on date. */
export function occursOn(rule: Recurrence, start: string, date: string): boolean {
  if (date < start) return false;
  const interval = rule.interval ?? 1;
  if (rule.freq === 'daily') return daysBetween(start, date) % interval === 0;
  if (rule.freq === 'weekly') {
    if (!(rule.weekdays ?? []).includes(weekdayOf(date))) return false;
    return ((mondayOf(date) - mondayOf(start)) / 7) % interval === 0;
  }
  const months = monthIndex(date) - monthIndex(start);
  return months % interval === 0 && monthlyDate(rule, monthIndex(date)) === date;
}

/** The first date of the recurrence on or after `from` (and never before start). */
export function nextOnOrAfter(rule: Recurrence, start: string, from: string): string {
  const at = from < start ? start : from;
  const interval = rule.interval ?? 1;
  if (rule.freq === 'daily') {
    const gap = daysBetween(start, at);
    return addDays(start, Math.ceil(gap / interval) * interval);
  }
  if (rule.freq === 'weekly') {
    for (let i = 0; i <= 7 * interval + 7; i++) {
      const day = addDays(at, i);
      if (occursOn(rule, start, day)) return day;
    }
    throw new Error('Weekly recurrence has no date');
  }
  const first = monthIndex(start);
  let index = monthIndex(at);
  const offset = (index - first) % interval;
  if (offset) index += interval - offset;
  for (let i = 0; i < 3; i++, index += interval) {
    const day = monthlyDate(rule, index);
    if (day && day >= at) return day;
  }
  throw new Error('Monthly recurrence has no date');
}

/** The first date of the recurrence strictly after `date`. */
export function nextAfter(rule: Recurrence, start: string, date: string): string {
  return nextOnOrAfter(rule, start, addDays(date, 1));
}

/** The last date of the recurrence on or before `date`, or null when none (before the first). */
export function lastOnOrBefore(rule: Recurrence, start: string, date: string): string | null {
  if (date < start) return null;
  const interval = rule.interval ?? 1;
  if (rule.freq === 'daily') return addDays(start, Math.floor(daysBetween(start, date) / interval) * interval);
  if (rule.freq === 'weekly') {
    for (let i = 0; i <= 7 * interval + 7; i++) {
      const day = addDays(date, -i);
      if (day < start) return null;
      if (occursOn(rule, start, day)) return day;
    }
    return null;
  }
  const first = monthIndex(start);
  let index = monthIndex(date);
  index -= (index - first) % interval;
  for (; index >= first; index -= interval) {
    const day = monthlyDate(rule, index);
    if (day && day <= date && day >= start) return day;
  }
  return null;
}

/** The next `count` dates on or after `from`, stopping after `end` when there is one. */
export function upcomingDates(rule: Recurrence, start: string, from: string, count: number, end: string | null = null): string[] {
  const out: string[] = [];
  let day = nextOnOrAfter(rule, start, from);
  while (out.length < count && (!end || day <= end) && day <= SCHEDULE_LAST_DATE) {
    out.push(day);
    day = nextAfter(rule, start, day);
  }
  return out;
}

// ── Time zones ──────────────────────────────────────────────────────────

export function isTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(instant: number, timeZone: string) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(formatted.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** The calendar date an instant falls on in a time zone. */
export function dateInZone(instant: Date | number, timeZone: string): string {
  const p = zonedParts(typeof instant === 'number' ? instant : instant.getTime(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant a date starts in a time zone: local midnight (or the first moment of the day, where midnight is skipped). */
export function zonedMidnight(date: string, timeZone: string): Date {
  const [y, m, d] = parts(date);
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (instant: number) => {
    const p = zonedParts(instant, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  let instant = guess - offsetAt(guess);
  const second = offsetAt(instant);
  if (guess - second !== instant) instant = guess - second;
  // A day whose midnight never happens (a clock change at 00:00) starts an hour later.
  while (dateInZone(instant, timeZone) < date) instant += 3_600_000;
  return new Date(instant);
}

// ── Words ───────────────────────────────────────────────────────────────

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_WEEK_WORDS: Record<string, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

function unit(freq: ScheduleFrequency, n: number): string {
  const word = freq === 'daily' ? 'day' : freq === 'weekly' ? 'week' : 'month';
  return n === 1 ? word : `${word}s`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const joinWords = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/** "Every Monday", "Every 2 weeks on Monday and Thursday", "Every month on the 1st", "Every month on the last Friday". */
export function describeRecurrence(rule: Recurrence): string {
  const interval = rule.interval ?? 1;
  if (rule.freq === 'daily') return interval === 1 ? 'Every day' : `Every ${interval} days`;
  if (rule.freq === 'weekly') {
    const days = [...new Set(rule.weekdays ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
    const names = weekdays ? 'weekday' : days.length === 7 ? 'day' : joinWords(days.map((d) => WEEKDAY_NAMES[d]));
    if (interval === 1) return weekdays ? 'Every weekday' : days.length === 7 ? 'Every day' : `Every ${names}`;
    return `Every ${interval} weeks on ${weekdays ? 'weekdays' : days.length === 7 ? 'every day' : names}`;
  }
  const every = interval === 1 ? 'Every month' : `Every ${interval} months`;
  if (rule.month_day !== undefined) {
    if (rule.month_day === 31) return `${every} on the last day`;
    return `${every} on the ${ordinal(rule.month_day)}${rule.month_day >= 29 ? ' (or the last day)' : ''}`;
  }
  return `${every} on the ${MONTH_WEEK_WORDS[String(rule.month_week)]} ${WEEKDAY_NAMES[rule.month_weekday ?? 1]}`;
}

/** "Repeats every Monday": the recurrence as a status line. */
export function repeatsLabel(rule: Recurrence): string {
  const words = describeRecurrence(rule);
  return `Repeats ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/** "Mon, Dec 1, 2026": a date the way the schedule screens list it. */
export function scheduleDateLabel(date: string, withYear = true): string {
  const [y, m, d] = parts(date);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** The built-in fill-ins for a run on `date`: { date: "2026-12-01", month: "December 2026" }. */
export function scheduleFills(date: string): Record<(typeof BUILT_IN_FILLS)[number], string> {
  const [y, m] = parts(date);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
  return { date, month };
}

/** A sensible first recurrence for a date: weekly on its weekday. */
export function defaultRecurrence(date: string): Recurrence {
  return { freq: 'weekly', interval: 1, weekdays: [weekdayOf(date)] };
}

// ── What the API answers ────────────────────────────────────────────────

/** One run (or copy) a schedule made, skipped or failed, by the date it was for. */
export interface ScheduleOccurrenceView {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  status: OccurrenceStatus;
  /** skipped: previous_run_open, lost_access, template_gone, project_gone, task_gone, task_not_done, needs_approval, runner_paused, assistant_switch_off. */
  reason: string | null;
  error: string | null;
  attempts: number;
  run_id: string | null;
  task_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ScheduleView {
  id: string;
  kind: ScheduleKind;
  template_id: string | null;
  template_name: string | null;
  task_id: string | null;
  task_title: string | null;
  project_id: string;
  project_name: string | null;
  recurrence: Recurrence;
  /** "Every month on the 1st". */
  recurrence_label: string;
  timezone: string;
  start_date: string;
  end_date: string | null;
  mode: RepeatMode;
  roles: Record<string, string | null>;
  values: Record<string, string>;
  key_date_offsets: Record<string, number>;
  create_initiative: boolean;
  skip_if_open: boolean;
  status: ScheduleStatus;
  /** Why it paused by itself: lost_access, template_gone, project_gone, task_gone, failed_twice, needs_approval, runner_paused, assistant_switch_off; null when someone paused it. */
  paused_reason: string | null;
  /** The next date: a template's next run, or the due date of a task's next copy. Null while paused, ended, or waiting for done. */
  next_on: string | null;
  next_run_at: string | null;
  /** The next five dates, in the schedule's time zone. */
  upcoming: string[];
  last_run_at: string | null;
  last_outcome: OccurrenceStatus | null;
  last_reason: string | null;
  /** Whose rights each run uses: whoever set it up or last changed what it makes. */
  run_as: string | null;
  run_as_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
}

/** Words for an occurrence's outcome: "Made", "Skipped: the previous run is still open". */
export const OCCURRENCE_REASON_WORDS: Record<string, string> = {
  previous_run_open: 'the previous run still has open tasks',
  lost_access: 'its runner can no longer use it',
  template_gone: 'the template is in Trash',
  project_gone: 'the project is in Trash',
  task_gone: 'the task is in Trash',
  task_not_done: 'the task was reopened',
  needs_approval: 'its runner needs approval for new tasks',
  runner_paused: 'its runner is a paused agent',
  assistant_switch_off: 'the person its runner works for turned off creating tasks',
  failed_twice: 'it failed twice in a row',
};

export function occurrenceLabel(o: Pick<ScheduleOccurrenceView, 'status' | 'reason'>): string {
  if (o.status === 'created') return 'Made';
  if (o.status === 'running') return 'Running';
  if (o.status === 'failed') return 'Failed';
  return o.reason && OCCURRENCE_REASON_WORDS[o.reason] ? `Skipped: ${OCCURRENCE_REASON_WORDS[o.reason]}` : 'Skipped';
}
