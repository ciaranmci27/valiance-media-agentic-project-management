'use client';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { loadRead, useRead, type Read } from '@/lib/query-cache';
import { toLocalDateString } from '@/lib/date-utils';
import { lineShareKey, type AccruingRetainerLine } from '@/lib/finance/summary';

export interface RetainerFinanceInputs {
  lineSharePercent: ReadonlyMap<string, number>;
  accruingRetainerLines: AccruingRetainerLine[];
}

const EMPTY: RetainerFinanceInputs = { lineSharePercent: new Map(), accruingRetainerLines: [] };

/**
 * Reads what the finance engine needs to show the company's real take from
 * retainers: the split on each invoice line, and the month covering today for
 * retainers that have no line yet. Both reads respect RLS: without
 * compensation.manage the splits come back empty, which is a real answer.
 * A failed read is not: it throws, because "no splits" would show gross
 * revenue as the company's net.
 */
async function fetchRetainerFinanceInputs(supabase: SupabaseClient): Promise<RetainerFinanceInputs> {
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
  return { lineSharePercent, accruingRetainerLines };
}

/**
 * The inputs as a cached read, one per local day (what accrues depends on
 * today). Invoices and retainers changing refresh it from live sync; line
 * shares are not in live sync, so their writer calls invalidateTables.
 */
function retainerFinanceRead(): Read<RetainerFinanceInputs> {
  return {
    key: `retainer-finance:${toLocalDateString()}`,
    tables: ['invoice_line_shares', 'project_invoices', 'project_retainers', 'project_retainer_amounts',
      'project_retainer_periods', 'project_retainer_shares'],
    load: () => fetchRetainerFinanceInputs(createClient()),
  };
}

/**
 * The store primes this during the boot load (behind the one boot screen), so
 * the first paint of Finances and the Dashboard already nets out revenue
 * splits instead of painting gross and dropping a moment later.
 */
export function loadRetainerFinanceInputs(): Promise<RetainerFinanceInputs> {
  return loadRead(retainerFinanceRead(), { force: true });
}

/** Shared by Finances and the Dashboard so the two agree. */
export function useRetainerFinanceInputs(enabled: boolean): RetainerFinanceInputs {
  return useRead(enabled ? retainerFinanceRead() : null).data ?? EMPTY;
}
