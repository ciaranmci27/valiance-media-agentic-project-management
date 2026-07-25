// Timezone-aware day boundaries + vesting ratios. Single source used by the finance
// engine (lib/finance/summary.ts) and the Finances page's chart/drilldown.

/** YYYY-MM-DD from a Date in local time. */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Epoch ms for the start of a given hour on a given day, in the given timezone. */
export function zonedHourStartMs(dateKey: string, hour: number, timezone?: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!timezone) return new Date(y, m - 1, d, hour).getTime();
  const targetAsUtc = Date.UTC(y, m - 1, d, hour);
  let candidate = targetAsUtc;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = formatter.formatToParts(new Date(candidate));
      const get = (type: Intl.DateTimeFormatPartTypes) => {
        const value = parts.find(part => part.type === type)?.value ?? '0';
        return type === 'hour' && value === '24' ? 0 : Number(value);
      };
      const displayedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      const delta = displayedAsUtc - targetAsUtc;
      if (delta === 0) return candidate;
      candidate -= delta;
    }
    return candidate;
  } catch {
    return new Date(y, m - 1, d, hour).getTime();
  }
}

export function localDayStartMs(dateKey: string, timezone?: string): number {
  return zonedHourStartMs(dateKey, 0, timezone);
}

export function localNextDayStartMs(dateKey: string, timezone?: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const nextDayKey = toDateKey(new Date(y, m - 1, d + 1));
  return zonedHourStartMs(nextDayKey, 0, timezone);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Fraction of a calendar day that has vested as of `nowMs` (0..1). */
export function dayVestingRatio(dateKey: string, nowMs: number, timezone?: string): number {
  const start = localDayStartMs(dateKey, timezone);
  const end = localNextDayStartMs(dateKey, timezone);
  if (end <= start) return nowMs >= end ? 1 : 0;
  return clamp01((nowMs - start) / (end - start));
}

/** Fraction of a given hour that has vested as of `nowMs` (0..1). */
export function hourVestingRatio(dateKey: string, hour: number, nowMs: number, timezone?: string): number {
  const start = zonedHourStartMs(dateKey, hour, timezone);
  const end = hour === 23
    ? localNextDayStartMs(dateKey, timezone)
    : zonedHourStartMs(dateKey, hour + 1, timezone);
  if (end <= start) return nowMs >= end ? 1 : 0;
  return clamp01((nowMs - start) / (end - start));
}
