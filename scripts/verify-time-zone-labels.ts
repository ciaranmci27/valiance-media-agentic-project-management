/**
 * Time zones as people read them (Settings > Account, SE2): the city and its
 * offset, never the database id, and search by city, region, long name or
 * offset. Pure, no database.
 *
 *   npm run -s test:time-zone-labels
 */
import { offsetLabel, offsetMinutes, timeZoneChoice, timeZoneChoices, timeZoneKeywords, zoneParts } from '../src/lib/time-zone-labels';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed += 1;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

// A winter day and a summer day: Phoenix stays at UTC-7, New York moves.
const WINTER = Date.UTC(2026, 0, 15, 12);
const SUMMER = Date.UTC(2026, 6, 15, 12);

const phoenix = timeZoneChoice('America/Phoenix', WINTER);
check('a zone reads as its city and offset, not its id', phoenix.label === 'Phoenix, UTC-7', phoenix);
check('the region and long name are kept for search', phoenix.region === 'America' && /Mountain/.test(phoenix.longName), phoenix);
check('a city with a space reads with a space', zoneParts('America/Argentina/Buenos_Aires').city === 'Buenos Aires' && zoneParts('America/Argentina/Buenos_Aires').region === 'America');
check('UTC itself reads as UTC', timeZoneChoice('UTC', WINTER).label === 'UTC, UTC+0', timeZoneChoice('UTC', WINTER));
check('half-hour offsets read in full', timeZoneChoice('Asia/Kolkata', WINTER).label === 'Kolkata, UTC+5:30', timeZoneChoice('Asia/Kolkata', WINTER));
check('daylight saving moves the offset', timeZoneChoice('America/New_York', WINTER).offset === 'UTC-5' && timeZoneChoice('America/New_York', SUMMER).offset === 'UTC-4');
check('GMT reads as UTC', offsetLabel('GMT') === 'UTC+0' && offsetLabel('GMT-7') === 'UTC-7' && offsetLabel('GMT+5:30') === 'UTC+5:30');
check('offsets sort by minutes', offsetMinutes('UTC-7') === -420 && offsetMinutes('UTC+5:30') === 330 && offsetMinutes('UTC+0') === 0);

const list = timeZoneChoices(WINTER, null, ['Europe/London', 'America/Phoenix', 'Asia/Tokyo', 'America/Denver']);
check('the list runs west to east, then by city', list.map((c) => c.id).join() === 'America/Denver,America/Phoenix,Europe/London,UTC,Asia/Tokyo', list.map((c) => c.id));
check('a saved zone missing from the list is kept', timeZoneChoices(WINTER, 'Pacific/Chatham', ['UTC']).some((c) => c.id === 'Pacific/Chatham'));
const keywords = timeZoneKeywords(phoenix);
check('search finds a zone by id, city, long name and offset', ['America/Phoenix', 'Phoenix', 'Mountain', 'UTC-7', 'GMT-7'].every((word) => keywords.includes(word)), keywords);

if (failures.length) {
  console.error(`time-zone-labels: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`time-zone-labels: ${passed} checks passed`);
