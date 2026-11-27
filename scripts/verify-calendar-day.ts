/**
 * Due dates on task cards and rows (src/lib/time-format.ts formatCalendarDay):
 * a date in another year says its year, so "Due Jan 10" (this year) never
 * sits beside "Due Jan 1" (next year) looking earlier; a calendar date is the
 * same day in every time zone. Pure logic.
 *
 *   npm run -s test:calendar-day
 */
import { formatCalendarDay } from '@/lib/time-format';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const now = new Date(2026, 10, 26, 12);
check('this year: month and day only', formatCalendarDay('2026-01-10', { now }) === 'Jan 10', formatCalendarDay('2026-01-10', { now }));
check('next year: with its year', formatCalendarDay('2027-01-01', { now }) === 'Jan 1, 2027', formatCalendarDay('2027-01-01', { now }));
check('last year: with its year', formatCalendarDay('2025-12-31', { now }) === 'Dec 31, 2025', formatCalendarDay('2025-12-31', { now }));
check('with the weekday', formatCalendarDay('2027-01-01', { now, weekday: true }) === 'Fri, Jan 1, 2027', formatCalendarDay('2027-01-01', { now, weekday: true }));
check('a timestamp\'s date part is the calendar date, whatever the zone', formatCalendarDay('2026-03-01T23:30:00-08:00', { now }) === 'Mar 1');

if (failures.length) {
  console.error(`calendar day: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`calendar day: ${passed} checks passed`);
