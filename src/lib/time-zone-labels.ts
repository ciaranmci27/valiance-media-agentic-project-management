/**
 * Time zones as people know them: the city and its offset ("Phoenix, UTC-7"),
 * never the database id ("America/Phoenix"). Settings > Account lists them
 * this way and searches city, region, the zone's long name ("Mountain
 * Standard Time") and the offset. Pure: the clock is passed in.
 */

export interface TimeZoneChoice {
  /** The IANA id saved on the profile ("America/Phoenix"). */
  id: string;
  /** "Phoenix, UTC-7". */
  label: string;
  /** "Phoenix". */
  city: string;
  /** "America", or empty for UTC. */
  region: string;
  /** "UTC-7", "UTC+5:30", "UTC+0". */
  offset: string;
  /** Minutes from UTC, for sorting. */
  offsetMinutes: number;
  /** "Mountain Standard Time", when the browser knows it. */
  longName: string;
}

/** A short list for browsers without Intl.supportedValuesOf. */
const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo',
  'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney',
];

/** "America/Argentina/Buenos_Aires" to { city: "Buenos Aires", region: "America" }. */
export function zoneParts(id: string): { city: string; region: string } {
  const segments = id.split('/');
  if (segments.length === 1) return { city: id.replace(/_/g, ' '), region: '' };
  return { city: segments[segments.length - 1].replace(/_/g, ' '), region: segments[0].replace(/_/g, ' ') };
}

/** "GMT-7" to "UTC-7"; plain "GMT" to "UTC+0". */
export function offsetLabel(shortOffset: string): string {
  return shortOffset === 'GMT' || shortOffset === 'UTC' ? 'UTC+0' : shortOffset.replace(/^GMT/, 'UTC');
}

/** "UTC-7" to -420, "UTC+5:30" to 330. */
export function offsetMinutes(label: string): number {
  const match = label.match(/UTC([+-])(\d+)(?::(\d+))?/);
  if (!match) return 0;
  return (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function namePart(id: string, at: number, style: 'shortOffset' | 'long'): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: style })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** One zone as a person reads it, at a moment (offsets change with daylight saving). */
export function timeZoneChoice(id: string, at: number): TimeZoneChoice {
  const { city, region } = zoneParts(id);
  const offset = offsetLabel(namePart(id, at, 'shortOffset') || 'GMT');
  const longName = namePart(id, at, 'long');
  return {
    id,
    label: `${city}, ${offset}`,
    city,
    region,
    offset,
    offsetMinutes: offsetMinutes(offset),
    longName: longName === offset ? '' : longName,
  };
}

/** Every zone the browser knows, west to east, then by city. The saved zone is kept even if the list lacks it. */
export function timeZoneChoices(at: number, current?: string | null, zones?: readonly string[]): TimeZoneChoice[] {
  let ids: string[];
  if (zones) ids = [...zones];
  else {
    try {
      ids = Intl.supportedValuesOf('timeZone');
    } catch {
      ids = [...FALLBACK_ZONES];
    }
  }
  if (!ids.includes('UTC')) ids.push('UTC');
  if (current && !ids.includes(current)) ids.push(current);
  return ids
    .map((id) => timeZoneChoice(id, at))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city));
}

/** What search matches for a zone: the city, region, id, long name and offset (with and without "GMT"). */
export function timeZoneKeywords(choice: TimeZoneChoice): string {
  return [choice.id, choice.city, choice.region, choice.longName, choice.offset, choice.offset.replace('UTC', 'GMT')]
    .filter(Boolean)
    .join(' ');
}
