import { DEFAULT_REGION, type Region } from './types';

/**
 * The region plain functions (formatMoney, formatHours, date helpers) fall
 * back to when no currency or locale is passed. An install is one
 * workspace, so there is one region per process: RegionProvider sets it in
 * the browser (and during the server render of client components), and
 * getRegion() sets it on the server. Server code that sends something out
 * (emails, PDFs, API text) still passes the region it read, so it never
 * depends on what ran first.
 */
let active: Region = DEFAULT_REGION;

export function activeRegion(): Region {
  return active;
}

export function setActiveRegion(region: Region): void {
  if (region.currency === active.currency && region.locale === active.locale && region.weekStart === active.weekStart) return;
  active = region;
}

/** The workspace locale, for toLocaleDateString and Intl formatters. */
export function appLocale(): string {
  return active.locale;
}
