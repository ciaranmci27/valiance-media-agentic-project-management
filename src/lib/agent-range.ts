import { toDateKey } from '@/lib/finance/vesting';
import { toLocalDateKey } from '@/lib/date-utils';
import type { DateRange } from '@/lib/finance/summary';

/**
 * Date-range vocabulary for the agent report.
 *
 * Shared rather than page-local because prefetching depends on it: warming a
 * range the page will not ask for is wasted work, and the only way to be sure
 * the keys agree is for both sides to resolve the range with this function.
 */

export type RangePreset = '7d' | '30d' | '90d' | 'mtd' | 'all' | 'custom';

export const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

/** What the report opens on, and therefore what is worth warming. */
export const DEFAULT_PRESET: RangePreset = '30d';

export function resolveRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  earliestDateKey: string | null,
  todayKey: string,
): DateRange {
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const today = new Date(ty, tm - 1, td);
  const makeStart = (daysBack: number): string => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    return toDateKey(d);
  };
  switch (preset) {
    case '7d': return { startKey: makeStart(6), endKey: todayKey };
    case '30d': return { startKey: makeStart(29), endKey: todayKey };
    case '90d': return { startKey: makeStart(89), endKey: todayKey };
    case 'mtd': return { startKey: toDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), endKey: todayKey };
    case 'all': return { startKey: earliestDateKey ?? makeStart(89), endKey: todayKey };
    case 'custom': {
      if (customStart && customEnd) {
        return customStart <= customEnd
          ? { startKey: customStart, endKey: customEnd }
          : { startKey: customEnd, endKey: customStart };
      }
      return { startKey: makeStart(29), endKey: todayKey };
    }
  }
}

/**
 * The range the report will open on for this viewer.
 *
 * `earliestDateKey` is null here on purpose: it only affects the "all time"
 * preset, which is never the default, so a warmer does not need workspace
 * history to compute the right key.
 */
export function defaultAgentAnalyticsRange(timezone?: string): DateRange {
  const todayKey = toLocalDateKey(new Date().toISOString(), timezone);
  return resolveRange(DEFAULT_PRESET, '', '', null, todayKey);
}
