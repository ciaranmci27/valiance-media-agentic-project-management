/** Display helpers for the member profile. */
import { appLocale } from '@/lib/region';

/** "12.5h", "0h": the app's one hours format. */
export { formatHours } from '@/lib/format';

/** "Nov 3, 2026" in en-US; the workspace locale's own order elsewhere. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Nov 3" for a due date (YYYY-MM-DD), with the year when it is not this year. */
export function formatDueDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString(appLocale(), {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "3:42 PM" in a time zone (the workspace locale's clock), and its offset ("UTC+1"). */
export function localClock(timezone: string, at: Date): { time: string; offset: string } {
  try {
    const time = at.toLocaleTimeString(appLocale(), { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
    // en-US so the offset always reads "GMT+1", which is rewritten to "UTC+1".
    const raw = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    return { time, offset: raw === 'GMT' ? 'UTC' : raw.replace('GMT', 'UTC') };
  } catch {
    return { time: at.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' }), offset: '' };
  }
}

/** The first word of a name, for copy like "What Maya does shows up here". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
