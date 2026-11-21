import { activeRegion } from './active';
import type { WeekStart } from './types';

/** The workspace's first day of the week (0 Sunday, 1 Monday, 6 Saturday). */
export function weekStartDay(): WeekStart {
  return activeRegion().weekStart;
}

/** Local midnight of the first day of the week on or before `date`, in the workspace's week. */
export function startOfWeek(date: Date = new Date(), firstDay: WeekStart = weekStartDay()): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const offset = (start.getDay() - firstDay + 7) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}
