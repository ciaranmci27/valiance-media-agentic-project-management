import type { Reminder } from '@/lib/types';
import { parseDateOnly } from '@/lib/date-utils';

/**
 * How reminders read on screen: when each is due, which group it sits in,
 * and which one is a task's next step. Dates are the viewer's local days;
 * a dated reminder with no time is due at 8 am (the bell's hour).
 */

export const DEFAULT_REMINDER_HOUR = 8;

/** A local day as YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(key: string, days: number): string {
  const date = parseDateOnly(key);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** The coming Monday (a week from today when today is Monday). */
export function nextMonday(from: Date): string {
  const offset = ((8 - from.getDay()) % 7) || 7;
  return addDays(dayKey(from), offset);
}

/** "14:30:00" or "14:30" to "2:30 pm". */
export function timeLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

/** "14:30:00" to "14:30", the TimeInput's format. */
export function toTimeInput(time: string | null): string {
  return time ? time.slice(0, 5) : '';
}

/** The moment a dated reminder is due, in the viewer's local time. */
export function dueMoment(reminder: Pick<Reminder, 'remind_on' | 'remind_at'>): Date | null {
  if (!reminder.remind_on) return null;
  const date = parseDateOnly(reminder.remind_on);
  const [h, m] = (reminder.remind_at ?? `${DEFAULT_REMINDER_HOUR}:00`).split(':').map(Number);
  date.setHours(h, m || 0, 0, 0);
  return date;
}

export type ReminderGroup = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'done';

export const REMINDER_GROUP_LABELS: Record<ReminderGroup, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  no_date: 'No date',
  done: 'Done',
};

export function reminderGroup(reminder: Reminder, now: Date = new Date()): ReminderGroup {
  if (reminder.status === 'done') return 'done';
  if (!reminder.remind_on) return 'no_date';
  const today = dayKey(now);
  if (reminder.remind_on < today) return 'overdue';
  if (reminder.remind_on > today) return 'upcoming';
  // Today: a set time that has passed is overdue; the default 8 am is not,
  // so "today" stays today all day.
  if (reminder.remind_at && (dueMoment(reminder)?.getTime() ?? 0) < now.getTime()) return 'overdue';
  return 'today';
}

/** Short "when" for a reminder: "Today 2:30 pm", "Tomorrow", "Fri", "Oct 30". */
export function whenLabel(reminder: Pick<Reminder, 'remind_on' | 'remind_at'>, now: Date = new Date()): string | null {
  if (!reminder.remind_on) return null;
  const today = dayKey(now);
  const date = parseDateOnly(reminder.remind_on);
  let label: string;
  if (reminder.remind_on === today) label = 'Today';
  else if (reminder.remind_on === addDays(today, 1)) label = 'Tomorrow';
  else if (reminder.remind_on === addDays(today, -1)) label = 'Yesterday';
  else if (reminder.remind_on > today && reminder.remind_on < addDays(today, 7)) {
    label = date.toLocaleDateString('en-US', { weekday: 'short' });
  } else {
    label = date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
  }
  return reminder.remind_at ? `${label} ${timeLabel(reminder.remind_at)}` : label;
}

/**
 * Open reminders in the order they matter: dated ones by when they are due,
 * then undated ones oldest first. Done ones, newest first.
 */
export function compareReminders(a: Reminder, b: Reminder): number {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  if (a.status === 'done') return (b.completed_at ?? '').localeCompare(a.completed_at ?? '');
  const ad = dueMoment(a)?.getTime();
  const bd = dueMoment(b)?.getTime();
  if (ad !== undefined && bd !== undefined && ad !== bd) return ad - bd;
  if (ad !== undefined && bd === undefined) return -1;
  if (ad === undefined && bd !== undefined) return 1;
  return a.created_at.localeCompare(b.created_at);
}

/** The step that moves a task forward: its most pressing open reminder. */
export function nextReminderFor(reminders: Reminder[], taskId: string): { next: Reminder; open: number } | null {
  const open = reminders.filter(r => r.task_id === taskId && r.status === 'open').sort(compareReminders);
  return open.length ? { next: open[0], open: open.length } : null;
}
