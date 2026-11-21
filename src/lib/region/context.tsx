'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import { formatMoney, formatMoneyCompact, formatMoneyExact, type MoneyOptions } from '@/lib/format';
import { setActiveRegion } from './active';
import { DEFAULT_REGION, type Region } from './types';

/**
 * The region in the browser. The root layout reads it on the server
 * (getRegion) and hands it down, so every client component formats amounts
 * and dates the way the page was rendered, with no request of its own.
 */
const RegionContext = createContext<Region>(DEFAULT_REGION);

export function RegionProvider({ region, children }: { region: Region; children: React.ReactNode }) {
  // Set during render, before any child formats a number: plain helpers
  // (formatMoney, date labels in lib/) read the same region as the hooks.
  setActiveRegion(region);
  return <RegionContext.Provider value={region}>{children}</RegionContext.Provider>;
}

export function useRegion(): Region {
  return useContext(RegionContext);
}

export interface MoneyFormat {
  /** A total ("$1,500", "$12.50"): see formatMoney. Pass a record's own currency when it has one. */
  (value: number, currency?: string | null): string;
  /** Always with the currency's decimals ("$1,234.50"): invoice lines, rates, payments. */
  exact: (value: number, currency?: string | null) => string;
  /** Short, for chart axes ("$1.2K"). */
  compact: (value: number, currency?: string | null) => string;
  currency: string;
  locale: string;
}

/**
 * Money in the workspace currency and locale, for client components. Reading
 * it through the hook re-renders the component when an Owner changes the region.
 *
 *   const money = useMoney();
 *   money(total)                      // workspace currency
 *   money.exact(line.amount, invoice.currency)
 */
export function useMoney(): MoneyFormat {
  const region = useRegion();
  const options = useCallback(
    (currency?: string | null): MoneyOptions => ({ currency: currency || region.currency, locale: region.locale }),
    [region.currency, region.locale],
  );
  return useMemo(() => Object.assign(
    (value: number, currency?: string | null) => formatMoney(value, options(currency)),
    {
      exact: (value: number, currency?: string | null) => formatMoneyExact(value, options(currency)),
      compact: (value: number, currency?: string | null) => formatMoneyCompact(value, options(currency)),
      currency: region.currency,
      locale: region.locale,
    },
  ), [options, region.currency, region.locale]);
}
