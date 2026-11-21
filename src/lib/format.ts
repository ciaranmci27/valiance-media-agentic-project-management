/**
 * The app's one way to show money and hours, so a figure reads the same on
 * the Dashboard, Finances, a project's Overview, the portal, emails and PDFs.
 *
 * Every amount is in a currency and a locale: the workspace's (Settings >
 * Workspace > Region) unless one is passed. An invoice, retainer or billing
 * plan passes its own currency, so a later workspace change never relabels
 * it. In the browser the workspace region comes from RegionProvider; server
 * code that sends something out passes the region it read (getRegion).
 */
import { activeRegion } from '@/lib/region/active';
import type { MoneyFormatPattern } from '@/lib/region/types';

export interface MoneyOptions {
  /** ISO 4217. Left out (or null), the workspace currency. */
  currency?: string | null;
  /** BCP 47. Left out (or null), the workspace locale. */
  locale?: string | null;
}

const formatters = new Map<string, Intl.NumberFormat>();

function cached(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = make();
    formatters.set(key, formatter);
  }
  return formatter;
}

function resolve(options?: MoneyOptions): { currency: string; locale: string } {
  const region = activeRegion();
  return {
    currency: (options?.currency || region.currency).toUpperCase(),
    locale: options?.locale || region.locale,
  };
}

/** A currency formatter, or null for a code Intl does not know (a hand-edited row). */
function currencyFormatter(locale: string, currency: string, digits: number): Intl.NumberFormat | null {
  try {
    return cached(`c|${locale}|${currency}|${digits}`, () => new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  } catch {
    return null;
  }
}

function numberFormatter(locale: string, digits: number): Intl.NumberFormat {
  try {
    return cached(`n|${locale}|${digits}`, () => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  } catch {
    return cached(`n|en-US|${digits}`, () => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
}

/** A currency's own decimals: 2 for USD and EUR, 0 for JPY and KRW. */
export function currencyDigits(currency: string): number {
  try {
    return cached(`d|${currency}`, () => new Intl.NumberFormat('en-US', { style: 'currency', currency }))
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function format(value: number, currency: string, locale: string, digits: number): string {
  // Never "-$0": an amount that rounds to nothing is nothing.
  const shown = Math.round(Math.abs(value) * 10 ** digits) === 0 ? 0 : value;
  const formatter = currencyFormatter(locale, currency, digits);
  if (formatter) return formatter.format(shown);
  return `${shown < 0 ? '-' : ''}${currency} ${numberFormatter(locale, digits).format(Math.abs(shown))}`;
}

/**
 * A money total: "$1,500", "$12.50", "-$80", "1.235 €", "￥1,500". No
 * decimals from 1,000 up; below that, the currency's decimals only when
 * there are any. A currency without decimals (JPY) never shows them.
 */
export function formatMoney(value: number, options?: MoneyOptions): string {
  const { currency, locale } = resolve(options);
  const digits = currencyDigits(currency);
  const abs = Math.abs(value);
  const scale = 10 ** digits;
  const hasFraction = digits > 0 && abs < 1000 && Math.round(abs * scale) % scale !== 0;
  return format(value, currency, locale, hasFraction ? digits : 0);
}

/**
 * An exact amount, always with the currency's decimals: invoice lines,
 * rates, payments, PDFs. "$1,234.50", "1.234,50 €", "￥1,235".
 */
export function formatMoneyExact(value: number, options?: MoneyOptions): string {
  const { currency, locale } = resolve(options);
  return format(value, currency, locale, currencyDigits(currency));
}

/** A short amount for chart axes and tight spaces: "$1.2K", "12 Tsd. €". */
export function formatMoneyCompact(value: number, options?: MoneyOptions): string {
  const { currency, locale } = resolve(options);
  try {
    return cached(`k|${locale}|${currency}`, () => new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })).format(value);
  } catch {
    return formatMoney(value, options);
  }
}

/** A plain number in the workspace locale: "1,234.5", "1.234,5". */
export function formatNumber(value: number, options?: { locale?: string | null; maximumFractionDigits?: number; minimumFractionDigits?: number }): string {
  const locale = options?.locale || activeRegion().locale;
  const max = options?.maximumFractionDigits ?? 2;
  const min = Math.min(options?.minimumFractionDigits ?? 0, max);
  try {
    return cached(`p|${locale}|${min}|${max}`, () => new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max })).format(value);
  } catch {
    return String(value);
  }
}

/**
 * The symbol a money input shows beside its number, and on which side:
 * { symbol: '$', position: 'prefix' } in en-US, { symbol: '€', position: 'suffix' } in de-DE.
 */
export function moneyAffix(options?: MoneyOptions): { symbol: string; position: 'prefix' | 'suffix' } {
  const { currency, locale } = resolve(options);
  const formatter = currencyFormatter(locale, currency, 0);
  if (!formatter) return { symbol: currency, position: 'prefix' };
  const parts = formatter.formatToParts(1);
  const symbolAt = parts.findIndex((p) => p.type === 'currency');
  const numberAt = parts.findIndex((p) => p.type === 'integer');
  return { symbol: parts[symbolAt]?.value ?? currency, position: symbolAt > numberAt ? 'suffix' : 'prefix' };
}

/** "2.5h", "2h", "0h" ("2,5h" in de-DE); a sliver under six minutes reads "<0.1h" rather than "0h". */
export function formatHours(hours: number, locale?: string | null): string {
  const lang = locale || activeRegion().locale;
  let formatter: Intl.NumberFormat;
  try {
    formatter = cached(`h|${lang}`, () => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }));
  } catch {
    formatter = cached('h|en-US', () => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }));
  }
  if (hours > 0 && hours < 0.05) return `<${formatter.format(0.1)}h`;
  return `${formatter.format(hours)}h`;
}

// ── Totals across currencies ─────────────────────────────────────────────────

/**
 * Amounts summed per currency, never across them. Rows without a currency
 * (stored before 1.7.0 added one) count in `fallback`, the workspace's.
 */
export function sumByCurrency<T>(
  rows: readonly T[],
  amount: (row: T) => number,
  currency: (row: T) => string | null | undefined,
  fallback: string = activeRegion().currency,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const code = (currency(row) || fallback).toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + (amount(row) || 0));
  }
  return totals;
}

/**
 * A total in the workspace currency, and how many rows in another currency
 * it leaves out, so a mixed list never adds euros to dollars.
 */
export function totalInCurrency<T>(
  rows: readonly T[],
  amount: (row: T) => number,
  currency: (row: T) => string | null | undefined,
  target: string = activeRegion().currency,
): { total: number; currency: string; excluded: number } {
  let total = 0;
  let excluded = 0;
  const code = target.toUpperCase();
  for (const row of rows) {
    if ((currency(row) || code).toUpperCase() === code) total += amount(row) || 0;
    else excluded += 1;
  }
  return { total, currency: code, excluded };
}

/** "€1,200 and $300": per-currency totals, the workspace currency first. */
export function formatMoneyGroups(totals: Map<string, number>, options?: { locale?: string | null }): string {
  const first = activeRegion().currency;
  const codes = [...totals.keys()].sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)));
  if (codes.length === 0) return formatMoney(0, { locale: options?.locale });
  const parts = codes.map((code) => formatMoney(totals.get(code) ?? 0, { currency: code, locale: options?.locale }));
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Leaves out 2 invoices in other currencies." for a total that left rows out; empty when none. */
export function excludedNote(excluded: number, noun = 'invoice', ofTotals = false): string {
  if (excluded <= 0) return '';
  if (ofTotals) return `${excluded} in ${excluded === 1 ? 'another currency' : 'other currencies'}, left out of the totals`;
  return `Leaves out ${excluded} ${noun}${excluded === 1 ? '' : 's'} in ${excluded === 1 ? 'another currency' : 'other currencies'}.`;
}

// ── For the database ─────────────────────────────────────────────────────────

const NUMBER_PARTS = new Set(['integer', 'group', 'decimal', 'fraction']);

function around(parts: Intl.NumberFormatPart[]): { before: string; after: string; integers: string[] } {
  const first = parts.findIndex((p) => p.type === 'integer');
  let last = first;
  parts.forEach((p, i) => { if (NUMBER_PARTS.has(p.type)) last = i; });
  return {
    before: parts.slice(0, first).map((p) => p.value).join(''),
    after: parts.slice(last + 1).map((p) => p.value).join(''),
    integers: parts.filter((p) => p.type === 'integer').map((p) => p.value),
  };
}

/**
 * How a currency reads in a locale, as pieces the database's format_money()
 * puts back together. Saved with the region, so SQL writes amounts exactly as
 * formatMoney does without a copy of Intl.
 */
export function moneyFormatPattern(currency: string, locale: string): MoneyFormatPattern {
  const digits = currencyDigits(currency);
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  const positive = around(formatter.formatToParts(1234567));
  const negative = around(formatter.formatToParts(-1234567));
  // With one decimal forced, so a currency without decimals still says what the separator is.
  const plain = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 1, maximumFractionDigits: 1 }).formatToParts(1234567.5);
  const grouped = formatter.formatToParts(1234).some((p) => p.type === 'group');
  return {
    prefix: positive.before,
    suffix: positive.after,
    negative_prefix: negative.before,
    negative_suffix: negative.after,
    group: plain.find((p) => p.type === 'group')?.value ?? '',
    decimal: plain.find((p) => p.type === 'decimal')?.value ?? '.',
    digits,
    min_group: grouped ? 1 : 2,
    secondary_group: positive.integers.length >= 3 ? positive.integers[positive.integers.length - 2].length : 3,
  };
}
