/**
 * Timezone-aware date utilities for converting UTC ISO strings
 * to strings suitable for HTML date/time inputs, using the user's
 * stored timezone preference (IANA identifier, e.g. 'America/Phoenix').
 *
 * When no timezone is provided, falls back to the browser's local timezone.
 */

function getParts(iso: string, timezone?: string) {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === type)?.value || '00';
  // Intl can return "24" for midnight with hour12:false in some environments — normalize to "00"
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/** UTC ISO string → "HH:mm" in the given timezone (for <input type="time">) */
export function toLocalTimeString(iso: string, timezone?: string): string {
  const { hour, minute } = getParts(iso, timezone);
  return `${hour}:${minute}`;
}

/** UTC ISO string → "YYYY-MM-DDThh:mm" in the given timezone (for <input type="datetime-local">) */
export function toLocalDatetimeString(iso: string, timezone?: string): string {
  const { year, month, day, hour, minute } = getParts(iso, timezone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** Today's date as "YYYY-MM-DD" in the given timezone (for <input type="date">) */
export function toLocalDateString(timezone?: string): string {
  const { year, month, day } = getParts(new Date().toISOString(), timezone);
  return `${year}-${month}-${day}`;
}
