import { cleanCurrency, cleanLocale } from './catalog';
import { DEFAULT_REGION, WEEK_STARTS, type Region, type RegionInput, type WeekStart } from './types';

/** A row of public.workspace_region, as PostgREST returns it (read with '*'). */
export interface WorkspaceRegionRow {
  currency?: string | null;
  locale?: string | null;
  week_start?: number | null;
  money_format?: unknown;
}

// Every column, so a column a newer release adds reads as its default until
// that release's migration runs, instead of failing the whole read.
export const WORKSPACE_REGION_COLUMNS = '*';

function weekStart(value: unknown): WeekStart | null {
  return typeof value === 'number' && (WEEK_STARTS as readonly number[]).includes(value) ? (value as WeekStart) : null;
}

/** A stored row as the region the app uses; anything missing or unreadable is the default. */
export function rowToRegion(row: WorkspaceRegionRow | null | undefined): Region {
  if (!row) return { ...DEFAULT_REGION };
  return {
    currency: cleanCurrency(row.currency) ?? DEFAULT_REGION.currency,
    locale: cleanLocale(row.locale) ?? DEFAULT_REGION.locale,
    weekStart: weekStart(row.week_start) ?? DEFAULT_REGION.weekStart,
  };
}

export function sameRegion(a: Region, b: Region): boolean {
  return a.currency === b.currency && a.locale === b.locale && a.weekStart === b.weekStart;
}

/** The save body for Settings > Workspace > Region, checked; every field is required. */
export function parseRegionInput(body: unknown): { data: RegionInput; error: null } | { data: null; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { data: null, error: 'Send a JSON object' };
  const raw = body as Record<string, unknown>;
  const currency = cleanCurrency(raw.currency);
  if (!currency) return { data: null, error: 'currency must be an ISO 4217 code, like USD or EUR' };
  const locale = cleanLocale(raw.locale);
  if (!locale) return { data: null, error: 'locale must be a language tag, like en-US or de-DE' };
  const start = weekStart(raw.weekStart);
  if (start === null) return { data: null, error: 'weekStart must be 1 (Monday), 0 (Sunday) or 6 (Saturday)' };
  return { data: { currency, locale, weekStart: start }, error: null };
}
