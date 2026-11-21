import type { WeekStart } from './types';

/**
 * What Settings > Workspace > Region offers. The API takes any ISO 4217 code
 * Intl knows and any locale Intl can format; these are the common ones the
 * pickers list first.
 */

export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'INR', 'SGD', 'HKD',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'MXN', 'BRL', 'ZAR', 'AED', 'ILS', 'KRW', 'TRY',
] as const;

export const LOCALES = [
  'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-NZ', 'en-IE', 'en-DE', 'en-NL', 'en-IN', 'en-ZA', 'en-SG',
  'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH', 'de-DE', 'de-AT', 'de-CH', 'es-ES', 'es-MX',
  'it-IT', 'nl-NL', 'pt-BR', 'pt-PT', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'ja-JP',
] as const;

export const WEEK_START_LABELS: Record<WeekStart, string> = { 1: 'Monday', 0: 'Sunday', 6: 'Saturday' };

/** A currency code Intl can format, upper case, or null. */
export function cleanCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : null;
    if (known && !known.includes(code)) return null;
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return code;
  } catch {
    return null;
  }
}

/** A locale Intl can format, in its canonical spelling ("en-us" becomes "en-US"), or null. */
export function cleanLocale(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 35) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(value.trim());
    if (!canonical || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(canonical)) return null;
    // Only a locale Intl actually has data for, not one it would quietly swap for English.
    if (Intl.NumberFormat.supportedLocalesOf([canonical]).length === 0) return null;
    return canonical;
  } catch {
    return null;
  }
}

/** "US dollar" (in English, the app's language). */
export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "$", "€", "CHF": the symbol a locale writes for a currency. */
export function currencySymbol(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
      .formatToParts(1)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** "English (United States)". */
export function localeName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** The usual week start for a locale, where the runtime knows it; Monday otherwise. */
export function localeWeekStart(locale: string): WeekStart {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (firstDay === 7) return 0;
    if (firstDay === 6) return 6;
    return 1;
  } catch {
    return 1;
  }
}

/** The currency most used where a locale's region is, for a first guess in setup. */
export function localeCurrency(locale: string): string | null {
  const region = (() => {
    try {
      return new Intl.Locale(locale).maximize().region ?? null;
    } catch {
      return null;
    }
  })();
  const byRegion: Record<string, string> = {
    US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IE: 'EUR', IN: 'INR', ZA: 'ZAR', SG: 'SGD',
    FR: 'EUR', BE: 'EUR', CH: 'CHF', DE: 'EUR', AT: 'EUR', ES: 'EUR', MX: 'MXN', IT: 'EUR', NL: 'EUR',
    BR: 'BRL', PT: 'EUR', SE: 'SEK', DK: 'DKK', NO: 'NOK', FI: 'EUR', PL: 'PLN', JP: 'JPY', CN: 'CNY',
    HK: 'HKD', KR: 'KRW', AE: 'AED', IL: 'ILS', TR: 'TRY', CZ: 'CZK',
  };
  return region ? byRegion[region] ?? null : null;
}
