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
 * Total dollars of hourly line items across paid invoices. Drives the FIFO
 * "paid hours" pool. Filtering on the invoice-level `invoice_type` would
 * miscount mixed invoices: a primarily-hourly invoice with recurring line
 * items would inflate the pool, and an hourly line item inside a
 * primarily-recurring invoice would never be credited.
 */
export function paidHourlyLineItemTotal(invoices: ProjectInvoice[]): number {
  let total = 0;
  for (const inv of invoices) {
    if (inv.status !== 'paid') continue;
    for (const li of ensureLineItems(inv)) {
      if (li.item_type === 'hourly') total += Number(li.amount) || 0;
    }
  }
  return total;
}

/**
 * Sum invoiced dollars across all non-draft invoices, broken down by line-item
 * type. Use this instead of bucketing by the invoice-level `invoice_type`,
 * which would misclassify mixed invoices (an `invoice_type='hourly'` invoice
 * may carry recurring line items, and vice versa).
 *
 * Cancelled invoices are excluded; pass already-filtered input if you also
 * want to exclude drafts.
 */
export function invoicedTotalsByItemType(
  invoices: ProjectInvoice[],
): { hourly: number; fixed: number; recurring: number } {
  const totals = { hourly: 0, fixed: 0, recurring: 0 };
  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue;
    for (const li of ensureLineItems(inv)) {
      const amt = Number(li.amount) || 0;
      if (li.item_type === 'hourly') totals.hourly += amt;
      else if (li.item_type === 'fixed') totals.fixed += amt;
      else if (li.item_type === 'recurring') totals.recurring += amt;
    }
  }
  return totals;
}

export type PaymentStatus = 'paid' | 'partial' | 'unpaid';

/**
 * FIFO waterfall against a pool of paid hourly dollars: walk entries oldest-
 * first, draining the pool by each entry's billable cost. Returns a map of
 * entry id → payment status. Entries must be passed in oldest-first order.
 *
 * Decoupled from the time-entry type so both the admin tracker and the
 * portal API can reuse it without depending on each other.
 */
export function fifoPaymentStatuses(
  entries: Array<{ id: string; hours: number }>,
  paidPool: number,
  hourlyRate: number,
): Map<string, PaymentStatus> {
  const map = new Map<string, PaymentStatus>();
  if (hourlyRate <= 0) return map;
  let pool = paidPool;
  for (const entry of entries) {
    const cost = entry.hours * hourlyRate;
    if (pool >= cost) {
      map.set(entry.id, 'paid');
      pool -= cost;
    } else if (pool > 0) {
      map.set(entry.id, 'partial');
      pool = 0;
    } else {
      map.set(entry.id, 'unpaid');
    }
  }
  return map;
}

/**
 * Same FIFO walk as `fifoPaymentStatuses`, but returns the per-entry billable
 * hours that remain unpaid. A fully-paid entry contributes 0; a partial entry
 * contributes only the slice past the drained pool; an unpaid entry contributes
 * its full hours. Used to build a single rolled-up hourly line item.
 */
export function unpaidHoursByEntry(
  entries: Array<{ id: string; hours: number }>,
  paidPool: number,
  hourlyRate: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (hourlyRate <= 0) return out;
  let pool = paidPool;
  for (const entry of entries) {
    const cost = entry.hours * hourlyRate;
    if (pool >= cost) {
      pool -= cost;
      continue;
    }
    if (pool > 0) {
      const coveredHours = pool / hourlyRate;
      out.set(entry.id, Math.max(0, entry.hours - coveredHours));
      pool = 0;
    } else {
      out.set(entry.id, entry.hours);
    }
  }
  return out;
}

/**
 * Format an ISO datetime (or YYYY-MM-DD) into MM/DD/YYYY in the viewer's local
 * timezone. Naïve YYYY-MM-DD slicing was a bug for non-UTC users: an entry
 * tracked at 11pm PST renders as 2026-04-04 in UTC but the user thinks of it
 * as April 3, so the description would show the wrong day.
 */
function fmtMDY(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  return `${m}/${d}/${y}`;
}

/**
 * Roll up unpaid time entries into a single hourly line-item draft.
 * Returns null when there are no unpaid hours. Caller is responsible for
 * assigning a fresh `id` and `position` before inserting into the form.
 *
 * The description follows the user's preferred format:
 *   "{hours} hours worked between MM/DD/YYYY and MM/DD/YYYY"
 * Date span is the oldest entry's start through the newest entry's end. The
 * caller is expected to pass only finalized entries (end_time non-null) since
 * unfinalized entries don't have billable hours yet.
 */
export function buildUnpaidHoursLineItem(
  entries: Array<{ id: string; start_time: string; end_time: string | null; hours: number }>,
  paidPool: number,
  hourlyRate: number,
): { description: string; amount: number; hours: number; startDate: string; endDate: string } | null {
  if (hourlyRate <= 0) return null;
  // Oldest-first ordering is required by the FIFO walk. Sort defensively.
  const sorted = [...entries].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const unpaidMap = unpaidHoursByEntry(sorted, paidPool, hourlyRate);
  if (unpaidMap.size === 0) return null;

  let totalHours = 0;
  let earliestStart: string | null = null;
  let latestEnd: string | null = null;
  for (const entry of sorted) {
    const unpaid = unpaidMap.get(entry.id);
    if (!unpaid || unpaid <= 0) continue;
    totalHours += unpaid;
    if (!earliestStart || entry.start_time < earliestStart) earliestStart = entry.start_time;
    const end = entry.end_time ?? entry.start_time;
    if (!latestEnd || end > latestEnd) latestEnd = end;
  }
  if (totalHours <= 0 || !earliestStart || !latestEnd) return null;

  return {
    description: formatUnpaidHoursDescription(totalHours, earliestStart, latestEnd),
    amount: Math.round(totalHours * hourlyRate * 100) / 100,
    hours: totalHours,
    startDate: earliestStart,
    endDate: latestEnd,
  };
}

/**
 * Format an unpaid-hours line-item description: "{hours} hours worked
 * between MM/DD/YYYY and MM/DD/YYYY". Used by both the full and partial
 * builders so the description shape stays consistent.
 */
export function formatUnpaidHoursDescription(hours: number, startDate: string, endDate: string): string {
  const hoursStr = hours.toFixed(4).replace(/\.?0+$/, '');
  return `${hoursStr} hours worked between ${fmtMDY(startDate)} and ${fmtMDY(endDate)}`;
}

/**
 * Build a partial unpaid-hours line item by walking unpaid entries in FIFO
 * order and stopping once the target hours threshold is reached. The line
 * item's date span reflects what's actually being invoiced — earliest unpaid
 * entry's start, through the end of the entry where the cutoff lands —
 * NOT the full unpaid range. So if you invoice 37.5 of 82.5 unpaid hours,
 * the description shows the dates corresponding to those first 37.5 hours.
 *
 * Returns null when there are no unpaid hours or targetHours is non-positive.
 * targetHours larger than the available unpaid balance is clamped silently.
 */
export function buildPartialUnpaidHoursLineItem(
  entries: Array<{ id: string; start_time: string; end_time: string | null; hours: number }>,
  paidPool: number,
  hourlyRate: number,
  targetHours: number,
): { description: string; amount: number; hours: number; startDate: string; endDate: string } | null {
  if (hourlyRate <= 0 || targetHours <= 0) return null;
  const sorted = [...entries].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const unpaidMap = unpaidHoursByEntry(sorted, paidPool, hourlyRate);
  if (unpaidMap.size === 0) return null;

  let acc = 0;
  let earliestStart: string | null = null;
  let cutoffEnd: string | null = null;

  for (const entry of sorted) {
    const unpaid = unpaidMap.get(entry.id);
    if (!unpaid || unpaid <= 0) continue;
    if (!earliestStart) earliestStart = entry.start_time;

    if (acc >= targetHours) break;

    const used = Math.min(unpaid, targetHours - acc);
    acc += used;
    cutoffEnd = entry.end_time ?? entry.start_time;
  }

  if (acc <= 0 || !earliestStart || !cutoffEnd) return null;

  const finalHours = Math.min(acc, targetHours);
  return {
    description: formatUnpaidHoursDescription(finalHours, earliestStart, cutoffEnd),
    amount: Math.round(finalHours * hourlyRate * 100) / 100,
    hours: finalHours,
    startDate: earliestStart,
    endDate: cutoffEnd,
  };
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
