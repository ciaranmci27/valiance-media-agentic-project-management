/**
 * The one time zone rule: times show, and repeats and schedules are saved,
 * in the signed-in person's profile time zone (Settings > Account). A
 * profile nobody has set yet takes the browser's zone on first sign-in
 * (TimeZoneSync), and until the profile loads the browser's zone stands in.
 *
 * Calendar dates (a due date, YYYY-MM-DD) have no time zone and never go
 * through this: they are the same day for everyone (formatCalendarDay).
 *
 * Client-safe and pure apart from the one module value the app sets when
 * the person's profile loads; the server passes zones explicitly.
 */

let profileZone: string | null = null;

/** The browser's own zone ("America/Phoenix"), or UTC where it cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Set by TimeZoneSync when the signed-in person's profile loads (null on sign-out). */
export function setAppTimeZone(zone: string | null | undefined): void {
  profileZone = zone && isKnownZone(zone) ? zone : null;
}

/** The zone the app shows times in and saves repeats in: the person's profile zone, else the browser's. */
export function appTimeZone(): string {
  return profileZone ?? browserTimeZone();
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a person's profile says: their zone once set (by them, or from
 * their browser on first sign-in), else the browser's. On a database
 * before 20261127001500 there is no flag, and the default UTC counts as
 * unset there, as it always did.
 */
export function profileTimeZone(member: { timezone?: string | null; timezone_set?: boolean | null } | null | undefined): string {
  const zone = member?.timezone;
  if (!zone || !isKnownZone(zone)) return browserTimeZone();
  if (member?.timezone_set === true) return zone;
  if (member?.timezone_set === false) return browserTimeZone();
  return zone === 'UTC' ? browserTimeZone() : zone;
}

/**
 * Whether the first sign-in should save the browser's zone to the profile:
 * only while the profile has never been set (timezone_set false), and only
 * when the browser's zone differs from what is stored.
 */
export function shouldDefaultTimeZone(member: { timezone?: string | null; timezone_set?: boolean | null } | null | undefined, browser: string): boolean {
  return !!member && member.timezone_set === false && !!browser && member.timezone !== browser;
}

/** The calendar day of a moment in a zone, as YYYY-MM-DD. */
export function dayKeyIn(value: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The year of a moment in a zone. */
export function yearIn(value: Date, zone: string): number {
  return Number(dayKeyIn(value, zone).slice(0, 4));
}
