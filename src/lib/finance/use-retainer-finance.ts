'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { lineShareKey, type AccruingRetainerLine } from '@/lib/finance/summary';

export interface RetainerFinanceInputs {
  lineSharePercent: ReadonlyMap<string, number>;
  accruingRetainerLines: AccruingRetainerLine[];
}

const EMPTY: RetainerFinanceInputs = { lineSharePercent: new Map(), accruingRetainerLines: [] };

/**
 * What the finance engine needs to show the company's real take from retainers:
 * the split on each invoice line, and the month covering today for retainers
 * that have no line yet. Shared by Finances and the Dashboard so the two agree.
 * Both reads respect RLS: without compensation.manage the splits come back empty.
 */
export function useRetainerFinanceInputs(enabled: boolean, refreshKey: string): RetainerFinanceInputs {
  const supabase = useMemo(() => createClient(), []);
  const [inputs, setInputs] = useState<RetainerFinanceInputs>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const [shares, accruing] = await Promise.all([
        supabase.from('invoice_line_shares').select('invoice_id, line_item_id, percent'),
        supabase.rpc('retainer_accruing_lines'),
      ]);
      if (cancelled) return;
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
      setInputs({ lineSharePercent, accruingRetainerLines });
    })().catch(() => {
      if (!cancelled) setInputs(EMPTY);
    });
    return () => {
      cancelled = true;
    };
    // refreshKey: invoices changing (a draft created, a line removed) and the
    // local day rolling over both change what accrues.
  }, [enabled, refreshKey, supabase]);

  return enabled ? inputs : EMPTY;
}
