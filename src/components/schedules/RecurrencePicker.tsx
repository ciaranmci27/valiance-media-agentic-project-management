'use client';

import { useId } from 'react';
import { CalendarDays, Repeat } from 'lucide-react';
import {
  describeRecurrence, INTERVAL_MAX, MONTH_WEEKS, ordinal, recurrenceSchema, scheduleDateLabel, upcomingDates, WEEKDAY_NAMES,
  WEEKDAY_SHORT, weekdayOf, type MonthWeek, type Recurrence, type ScheduleFrequency,
} from '@/lib/schedules';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { todayIn } from './schedule-actions';

/**
 * How often something repeats, in plain controls: Daily, Weekly or Monthly;
 * every N days, weeks or months; which weekdays (Monday first); for a month,
 * a day of it or "the first Monday". Under them, the rule in words ("Every
 * month on the 1st") and the next five dates in its time zone, so a person
 * sees exactly what they set. Controlled: it never holds a rule of its own.
 */

const FREQ_LABELS: Record<ScheduleFrequency, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const UNIT: Record<ScheduleFrequency, [string, string]> = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'] };
/** Monday first, the way people read a week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MONTH_WEEK_LABELS: Record<string, string> = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', '-1': 'Last' };

const dayOfMonth = (date: string) => Number(date.slice(8, 10));
/** Which week of its month a date falls in: 1 to 4, or -1 when it is in the last seven days past the fourth. */
const monthWeekOf = (date: string): MonthWeek => {
  const week = Math.ceil(dayOfMonth(date) / 7);
  return (week > 4 ? -1 : week) as MonthWeek;
};

/** A fresh rule for a frequency, shaped from the start date: weekly on its weekday, monthly on its day. */
function ruleFor(freq: ScheduleFrequency, startDate: string, interval = 1): Recurrence {
  const capped = Math.min(Math.max(1, interval), INTERVAL_MAX[freq]);
  if (freq === 'daily') return { freq, interval: capped };
  if (freq === 'weekly') return { freq, interval: capped, weekdays: [weekdayOf(startDate)] };
  return { freq, interval: capped, month_day: dayOfMonth(startDate) };
}

export function RecurrencePicker({ value, onChange, startDate, timeZone, endDate = null, error }: {
  value: Recurrence;
  onChange: (next: Recurrence) => void;
  /** The first day it may fall on: dates count from here (every 2 weeks from this week). */
  startDate: string;
  /** IANA zone: "today" for the preview. */
  timeZone: string;
  /** No preview date after this day. */
  endDate?: string | null;
  error?: string;
}) {
  const id = useId();
  const interval = value.interval ?? 1;
  const [one, many] = UNIT[value.freq];
  const byWeekday = value.freq === 'monthly' && value.month_day === undefined;

  const setFreq = (freq: ScheduleFrequency) => {
    if (freq !== value.freq) onChange(ruleFor(freq, startDate, interval));
  };
  const setInterval = (next: number | '') => {
    if (next === '' || !Number.isFinite(next)) return;
    onChange({ ...value, interval: Math.min(Math.max(1, Math.round(next)), INTERVAL_MAX[value.freq]) });
  };
  const toggleDay = (day: number) => {
    const days = value.weekdays ?? [];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    // A week always keeps one day: the last one cannot be switched off.
    if (!next.length) return;
    onChange({ freq: 'weekly', interval, weekdays: [...next].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)) });
  };
  const setMonthMode = (weekday: boolean) => {
    if (weekday === byWeekday) return;
    onChange(weekday
      ? { freq: 'monthly', interval, month_week: monthWeekOf(startDate), month_weekday: weekdayOf(startDate) }
      : { freq: 'monthly', interval, month_day: dayOfMonth(startDate) });
  };

  // The words and the next dates, from the rule as set (a half-typed one shows its problem instead).
  const parsed = recurrenceSchema.safeParse(value);
  const today = todayIn(timeZone);
  let upcoming: string[] = [];
  if (parsed.success) {
    try { upcoming = upcomingDates(parsed.data, startDate, today > startDate ? today : startDate, 5, endDate); } catch { upcoming = []; }
  }
  const problem = error ?? (parsed.success ? null : parsed.error.issues[0]?.message ?? 'Check the pattern');
  const thisYear = today.slice(0, 4);

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="How often" className="seg-track w-full sm:w-auto">
        {(Object.keys(FREQ_LABELS) as ScheduleFrequency[]).map((freq) => (
          <button
            key={freq}
            type="button"
            role="radio"
            aria-checked={value.freq === freq}
            onClick={() => setFreq(freq)}
            className={`seg-item flex-1 sm:flex-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${value.freq === freq ? 'is-active' : ''}`}
          >
            {FREQ_LABELS[freq]}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm text-zinc-300">
        <span id={`${id}-every`}>Every</span>
        <NumberInput
          value={interval}
          onChange={setInterval}
          min={1}
          max={INTERVAL_MAX[value.freq]}
          precision={0}
          showButtons={false}
          className="w-16"
          inputClassName="tabular-nums"
          aria-label={`Every how many ${many}`}
        />
        <span>{interval === 1 ? one : many}</span>
      </div>

      {value.freq === 'weekly' && (
        <div>
          <p id={`${id}-days`} className="mb-1.5 text-xs text-zinc-400">On</p>
          <div role="group" aria-labelledby={`${id}-days`} className="seg-track flex w-full">
            {WEEK_ORDER.map((day) => {
              const on = (value.weekdays ?? []).includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={WEEKDAY_NAMES[day]}
                  onClick={() => toggleDay(day)}
                  className={`seg-item min-w-0 flex-1 !px-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${on ? 'is-active !text-brand-200' : ''}`}
                >
                  {WEEKDAY_SHORT[day]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {value.freq === 'monthly' && (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Which day of the month" className="seg-track w-full sm:w-auto">
            {[false, true].map((weekday) => (
              <button
                key={String(weekday)}
                type="button"
                role="radio"
                aria-checked={byWeekday === weekday}
                onClick={() => setMonthMode(weekday)}
                className={`seg-item flex-1 sm:flex-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${byWeekday === weekday ? 'is-active' : ''}`}
              >
                {weekday ? 'On a weekday' : 'On a date'}
              </button>
            ))}
          </div>
          {byWeekday ? (
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <span>On the</span>
              <Select
                ariaLabel="Which week"
                value={String(value.month_week ?? 1)}
                onChange={(next) => onChange({ freq: 'monthly', interval, month_week: Number(next) as MonthWeek, month_weekday: value.month_weekday ?? weekdayOf(startDate) })}
                options={MONTH_WEEKS.map((week) => ({ value: String(week), label: MONTH_WEEK_LABELS[String(week)] }))}
                className="w-32"
              />
              <Select
                ariaLabel="Which weekday"
                value={String(value.month_weekday ?? 1)}
                onChange={(next) => onChange({ freq: 'monthly', interval, month_week: value.month_week ?? 1, month_weekday: Number(next) })}
                options={WEEK_ORDER.map((day) => ({ value: String(day), label: WEEKDAY_NAMES[day] }))}
                className="min-w-0 flex-1"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <span>On day</span>
              <NumberInput
                value={value.month_day ?? 1}
                onChange={(next) => { if (next !== '' && Number.isFinite(next)) onChange({ freq: 'monthly', interval, month_day: Math.min(31, Math.max(1, Math.round(next))) }); }}
                min={1}
                max={31}
                precision={0}
                showButtons={false}
                className="w-16"
                inputClassName="tabular-nums"
                aria-label="Day of the month"
              />
              <span className="text-xs text-zinc-400">{(value.month_day ?? 1) >= 29 ? 'Shorter months use their last day' : `The ${ordinal(value.month_day ?? 1)} of each month`}</span>
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg bg-white/[0.04] px-3 py-2.5" aria-live="polite">
        {problem ? (
          <p role="alert" className="text-sm text-red-300">{problem}</p>
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm font-medium text-white">
              <Repeat size={14} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
              {describeRecurrence(parsed.success ? parsed.data : value)}
            </p>
            {upcoming.length > 0 ? (
              <>
                <p className="mt-2 text-[11px] text-zinc-400">Next {upcoming.length === 1 ? 'date' : `${upcoming.length} dates`}</p>
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Next dates">
                  {upcoming.map((date) => (
                    <li key={date} className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] tabular-nums text-zinc-200">
                      <CalendarDays size={11} className="text-zinc-400" aria-hidden="true" />
                      {scheduleDateLabel(date, date.slice(0, 4) !== thisYear)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-1 text-xs text-amber-200">No dates left before the end date.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
