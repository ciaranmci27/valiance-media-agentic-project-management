/**
 * Timesheet hours: days in a person's own timezone and worked time for
 * converted agent entries (src/components/time/timesheet-dates.ts).
 * Run with: npm run test:timesheet
 */
import { dayKeyInZone, recentDayKeysInZone, workedHoursByDayInZone, workedSegments } from '../src/components/time/timesheet-dates';
import type { TimeEntry } from '../src/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const entry = (over: Partial<TimeEntry>): TimeEntry => ({
  id: 'e', project_id: 'p', member_id: 'm', start_time: over.segments?.[0]?.start ?? '2026-11-22T01:00:00Z',
  end_time: null, segments: [], description: '', created_at: '', updated_at: '', ...over,
} as TimeEntry);

// Sunday 18:00 to 20:00 in Denver (UTC-7) is Monday 01:00 to 03:00 in UTC.
const sundayEvening = entry({ end_time: '2026-11-23T03:00:00Z', segments: [{ start: '2026-11-23T01:00:00Z', end: '2026-11-23T03:00:00Z' }] });
const denver = workedHoursByDayInZone(sundayEvening, Date.now(), 'America/Denver');
const utc = workedHoursByDayInZone(sundayEvening, Date.now(), 'UTC');
check('zone: a Denver Sunday evening counts on Sunday in Denver', denver.get('2026-11-22') === 2 && denver.size === 1, [...denver]);
check('zone: and on Monday in UTC', utc.get('2026-11-23') === 2 && utc.size === 1, [...utc]);

// 22:00 to 02:00 UTC crosses midnight: 2 hours each side.
const overnight = entry({ end_time: '2026-11-21T02:00:00Z', segments: [{ start: '2026-11-20T22:00:00Z', end: '2026-11-21T02:00:00Z' }] });
const split = workedHoursByDayInZone(overnight, Date.now(), 'UTC');
check('zone: a session over midnight splits between the two days', split.get('2026-11-20') === 2 && split.get('2026-11-21') === 2, [...split]);

// India is UTC+5:30: 18:00 to 20:00 UTC is 23:30 to 01:30 there, split at a half-hour midnight.
const half = workedHoursByDayInZone(entry({ end_time: '2026-11-20T20:00:00Z', segments: [{ start: '2026-11-20T18:00:00Z', end: '2026-11-20T20:00:00Z' }] }), Date.now(), 'Asia/Kolkata');
check('zone: a half-hour offset splits exactly at its midnight', half.get('2026-11-20') === 0.5 && half.get('2026-11-21') === 1.5, [...half]);

check('zone: an unknown zone falls back to UTC', dayKeyInZone(Date.parse('2026-11-23T01:00:00Z'), 'Not/AZone') === '2026-11-23');

// A converted agent entry: segments hold the billed slot (2 h), the snapshot the worked 1 h.
const converted = entry({
  member_id: 'agent', end_time: '2026-11-20T12:00:00Z', billing_converted_at: '2026-11-20T13:00:00Z',
  segments: [{ start: '2026-11-20T10:00:00Z', end: '2026-11-20T12:00:00Z' }],
  raw_time_snapshot: { version: 1, start_time: '2026-11-20T10:00:00Z', end_time: '2026-11-20T11:00:00Z', segments: [{ start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:00:00Z' }], worked_ms: 3_600_000, captured_at: '' },
});
check('worked: a converted agent entry counts its worked time, not the billed slot',
  workedHoursByDayInZone(converted, Date.now(), 'UTC').get('2026-11-20') === 1, [...workedHoursByDayInZone(converted, Date.now(), 'UTC')]);
check('worked: an unconverted entry uses its own segments', workedSegments(sundayEvening).length === 1);

const now = Date.parse('2026-11-21T05:00:00Z');
const recent = recentDayKeysInZone(now, 'America/Denver');
check('recent: 30 day keys, today first, in the zone', recent.length === 30 && recent[0] === '2026-11-20' && recent[29] === '2026-10-22', [recent[0], recent[29], recent.length]);

if (failures.length) {
  console.log(`timesheet: ${passed} passed, ${failures.length} failed:`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log(`timesheet: ${passed} checks passed.`);
