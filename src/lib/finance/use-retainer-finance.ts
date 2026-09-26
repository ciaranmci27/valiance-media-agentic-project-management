'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { lineShareKey, type AccruingRetainerLine } from '@/lib/finance/summary';

export interface RetainerFinanceInputs {
  lineSharePercent: ReadonlyMap<string, number>;
  accruingRetainerLines: AccruingRetainerLine[];
}

const EMPTY: RetainerFinanceInputs = { lineSharePercent: new Map(), accruingRetainerLines: [] };

// The last loaded inputs. The store primes this during the boot load (behind
// the one boot screen), so the first paint of Finances and the Dashboard already
// nets out revenue splits. Without it the money figures painted gross, then
// dropped a moment later when the splits arrived.
let cached: RetainerFinanceInputs | null = null;
const RETAINER_FINANCE_EVENT = 'retainer-finance-updated';

/**
 * Reads what the finance engine needs to show the company's real take from
 * retainers: the split on each invoice line, and the month covering today for
 * retainers that have no line yet. Both reads respect RLS: without
 * compensation.manage the splits come back empty, which is a real answer.
 * A failed read is not: it throws, because "no splits" would show gross
 * revenue as the company's net.
 */
export async function loadRetainerFinanceInputs(supabase: SupabaseClient): Promise<RetainerFinanceInputs> {
  const [shares, accruing] = await Promise.all([
    supabase.from('invoice_line_shares').select('invoice_id, line_item_id, percent'),
    supabase.rpc('retainer_accruing_lines'),
  ]);
  if (shares.error) throw shares.error;
  if (accruing.error) throw accruing.error;
  const lineSharePercent = new Map<string, number>();
  for (const row of shares.data ?? []) {
    const key = lineShareKey(row.invoice_id, row.line_item_id);
    lineSharePercent.set(key, (lineSharePercent.get(key) ?? 0) + Number(row.percent));
  }
  const accruingRetainerLines = ((accruing.data ?? []) as AccruingRetainerLine[]).map((row) => ({
    ...row,
    amount: Number(row.amount),
    share_percent: Number(row.share_percent),
  }));
  cached = { lineSharePercent, accruingRetainerLines };
  // Pages already showing figures pick up a reload they did not start (the
  // store's retry after a failed boot read).
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RETAINER_FINANCE_EVENT));
  return cached;
}

/** Shared by Finances and the Dashboard so the two agree. */
export function useRetainerFinanceInputs(enabled: boolean, refreshKey: string): RetainerFinanceInputs {
  const supabase = useMemo(() => createClient(), []);
  const [inputs, setInputs] = useState<RetainerFinanceInputs>(() => cached ?? EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadRetainerFinanceInputs(supabase)
      .then((next) => {
        if (!cancelled) setInputs(next);
      })
      .catch(() => {
        /* keep what is showing */
      });
    return () => {
      cancelled = true;
    };
    // refreshKey: invoices changing (a draft created, a line removed) and the
    // local day rolling over both change what accrues.
  }, [enabled, refreshKey, supabase]);

  useEffect(() => {
    if (!enabled) return;
    const onUpdated = () => { if (cached) setInputs(cached); };
    window.addEventListener(RETAINER_FINANCE_EVENT, onUpdated);
    return () => window.removeEventListener(RETAINER_FINANCE_EVENT, onUpdated);
  }, [enabled]);

  return enabled ? inputs : EMPTY;
}
