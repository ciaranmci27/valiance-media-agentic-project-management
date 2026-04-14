import type { InvoiceLineItem, InvoiceType, ProjectInvoice, RecurrenceFrequency } from './types';

/**
 * Generate a stable client-side UUID for line items. Crypto.randomUUID is
 * available in all modern browsers and Node 19+.
 */
export function newLineItemId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (vanishingly rare path)
  return 'li_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Lazy migration: when an invoice has no line_items, synthesize a single
 * line item from the legacy invoice_type + amount + description. This lets
 * pre-line-item rows behave like simple one-line invoices everywhere.
 */
export function ensureLineItems(invoice: ProjectInvoice): InvoiceLineItem[] {
  if (Array.isArray(invoice.line_items) && invoice.line_items.length > 0) {
    return invoice.line_items;
  }
  // Legacy rows store their copy at the invoice level (invoice.description).
  // Leave the synthesized line item's description blank so consumers that
  // render both don't double-print the same text.
  return [
    {
      id: 'legacy:' + invoice.id,
      position: 0,
      item_type: invoice.invoice_type,
      amount: invoice.amount,
      description: '',
      service_start_date: null,
      service_end_date: null,
      recurrence_frequency: null,
    },
  ];
}

/** Sum of all line-item amounts. */
export function lineItemsTotal(items: InvoiceLineItem[]): number {
  return items.reduce((s, li) => s + (Number(li.amount) || 0), 0);
}

/**
 * Dominant line-item type by amount. Used to set the legacy `invoice_type`
 * column so existing filters keep working.
 */
export function dominantInvoiceType(items: InvoiceLineItem[]): InvoiceType {
  if (items.length === 0) return 'fixed';
  const totals: Record<InvoiceType, number> = { hourly: 0, fixed: 0, recurring: 0 };
  for (const li of items) totals[li.item_type] += Number(li.amount) || 0;
  let best: InvoiceType = items[0].item_type;
  let bestVal = -Infinity;
  (Object.keys(totals) as InvoiceType[]).forEach((t) => {
    if (totals[t] > bestVal) {
      bestVal = totals[t];
      best = t;
    }
  });
  return best;
}

/**
 * Add `months` to `date` in place, clamping the day to the last day of the
 * target month if the original day doesn't exist there. Without clamping,
 * JS's native setMonth overflows: Jan 31 + 1 month → Mar 3, not Feb 28.
 */
function advanceMonthsClamped(date: Date, months: number): void {
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDayOfNewMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDayOfNewMonth));
}

/**
 * Suggest a service end date given a start + frequency. Returns YYYY-MM-DD.
 * "monthly" → start + 1 month - 1 day, etc. Used to autofill the form when
 * the user picks a recurrence_frequency.
 */
export function suggestServiceEnd(startKey: string, frequency: RecurrenceFrequency): string {
  const [y, m, d] = startKey.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(start);
  switch (frequency) {
    case 'weekly':    end.setDate(end.getDate() + 6); break;
    case 'monthly':   advanceMonthsClamped(end, 1); end.setDate(end.getDate() - 1); break;
    case 'quarterly': advanceMonthsClamped(end, 3); end.setDate(end.getDate() - 1); break;
    case 'annual':    advanceMonthsClamped(end, 12); end.setDate(end.getDate() - 1); break;
  }
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

/**
 * Number of days (inclusive) between two YYYY-MM-DD keys.
 */
export function daysInclusive(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const ms = new Date(ey, em - 1, ed).getTime() - new Date(sy, sm - 1, sd).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/**
 * Iterate every YYYY-MM-DD key in [startKey, endKey] inclusive.
 */
export function* iterDateKeys(startKey: string, endKey: string): Generator<string> {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (cursor.getTime() <= end.getTime()) {
    yield `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    cursor.setDate(cursor.getDate() + 1);
  }
}

/**
 * Spread a non-hourly line item's amount across the days it covers.
 * - Items with both service_start_date and service_end_date amortize evenly.
 * - Items without service dates fall on `fallbackDate` as a single-day amount.
 * Hourly items contribute nothing here (already represented by tracked time).
 *
 * Returns a Map<YYYY-MM-DD, dollars>.
 */
export function spreadLineItem(item: InvoiceLineItem, fallbackDate: string): Map<string, number> {
  const out = new Map<string, number>();
  if (item.item_type === 'hourly') return out;
  const amount = Number(item.amount) || 0;
  if (amount <= 0) return out;

  // Pick a start/end pair. If only one bound is set, treat the item as a
  // single-day charge on that date. If neither is set, fall back to the
  // invoice date so the amount still appears somewhere on the chart.
  const rawStart = item.service_start_date || item.service_end_date;
  const rawEnd = item.service_end_date || item.service_start_date;
  if (!rawStart || !rawEnd) {
    out.set(fallbackDate, (out.get(fallbackDate) ?? 0) + amount);
    return out;
  }
  const start = rawStart <= rawEnd ? rawStart : rawEnd;
  const end = rawStart <= rawEnd ? rawEnd : rawStart;
  const days = daysInclusive(start, end);
  const perDay = amount / days;
  for (const k of iterDateKeys(start, end)) {
    out.set(k, (out.get(k) ?? 0) + perDay);
  }
  return out;
}
