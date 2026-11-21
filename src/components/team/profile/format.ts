/** Display helpers for the member profile. */

const hoursFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "12.5 h", "0 h". */
export function formatHours(hours: number): string {
  return `${hoursFormat.format(hours)} h`;
}

/** "Nov 3, 2026". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Nov 3" for a due date (YYYY-MM-DD), with the year when it is not this year. */
export function formatDueDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "3:42 PM" in a time zone, and its offset ("UTC+1"). */
export function localClock(timezone: string, at: Date): { time: string; offset: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    const time = parts.filter((p) => p.type !== 'timeZoneName').map((p) => p.value).join('').trim();
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    return { time, offset: raw === 'GMT' ? 'UTC' : raw.replace('GMT', 'UTC') };
  } catch {
    return { time: at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), offset: '' };
  }
}

/** The first word of a name, for copy like "What Maya does shows up here". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
