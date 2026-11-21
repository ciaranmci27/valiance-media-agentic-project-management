/**
 * The workspace's region: the currency and locale every amount and date is
 * shown in, and the day weeks start on. One row for the whole workspace,
 * set by an Owner in Settings > Workspace > Region.
 */

/** 0 = Sunday, 1 = Monday, 6 = Saturday (Date.getDay numbering). */
export type WeekStart = 0 | 1 | 6;

export const WEEK_STARTS: readonly WeekStart[] = [1, 0, 6];

export interface Region {
  /** ISO 4217, upper case: "USD", "EUR". */
  currency: string;
  /** BCP 47: "en-US", "de-DE". */
  locale: string;
  weekStart: WeekStart;
}

/** What an Owner saves. */
export type RegionInput = Region;

/**
 * How the workspace currency reads in the workspace locale, taken from Intl
 * when an Owner saves, so database functions (activity lines, Trash labels,
 * billing notices) write amounts the way the app shows them.
 */
export interface MoneyFormatPattern {
  prefix: string;
  suffix: string;
  negative_prefix: string;
  negative_suffix: string;
  group: string;
  decimal: string;
  /** The currency's own decimals: 2 for USD, 0 for JPY. */
  digits: number;
  /** 2 where 4-digit numbers are not grouped ("1234,50 €" in es-ES). */
  min_group: number;
  /** Digits between separators after the first group of 3: 2 in en-IN (12,34,567). */
  secondary_group: number;
}

/** The region until an Owner sets one: what the app always used. */
export const DEFAULT_REGION: Region = Object.freeze({ currency: 'USD', locale: 'en-US', weekStart: 1 }) as Region;
