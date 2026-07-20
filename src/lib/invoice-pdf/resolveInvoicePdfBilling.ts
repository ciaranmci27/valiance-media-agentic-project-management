import type {
  InvoiceLineItem,
  InvoiceTimeEntryAllocation,
  TimeEntry,
} from '../types';
import { getWorkedHours } from '../time-entry-utils';
import type {
  InvoicePdfLineItem,
  InvoicePdfRateBreakdown,
} from './types';

const HOURS_EPSILON = 0.0000011;

function toCents(value: number): number {
  return Math.round(value * 100);
}

function money(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export class InvoicePdfIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoicePdfIntegrityError';
  }
}

export interface ResolvedInvoicePdfAllocation {
  lineItemId: string;
  timeEntry: TimeEntry;
  startOffsetHours: number;
  hours: number;
  amount: number;
  hourlyRate: number;
}

export interface ResolvedInvoicePdfBilling {
  lineItems: InvoicePdfLineItem[];
  allocations: ResolvedInvoicePdfAllocation[];
}

function customHourlyLineItem(lineItem: InvoiceLineItem): InvoicePdfLineItem {
  return {
    ...lineItem,
    quantity: null,
    rateLabel: 'Custom',
    allocationStatus: 'custom',
    rateBreakdown: [],
  };
}

function fixedLineItem(lineItem: InvoiceLineItem): InvoicePdfLineItem {
  return {
    ...lineItem,
    quantity: 1,
    rateLabel: money(Number(lineItem.amount) || 0),
    allocationStatus: 'custom',
    rateBreakdown: [],
  };
}

/**
 * Resolve the exact billing facts rendered on an invoice PDF.
 *
 * Mapped hourly rows are fail-closed: if their saved allocation dollars,
 * session hours, offsets, or rates disagree, PDF generation stops instead of
 * presenting invented quantities. Hourly rows with no allocations remain
 * valid custom charges, but never claim a fabricated quantity or rate.
 */
export function resolveInvoicePdfBilling(
  lineItems: InvoiceLineItem[],
  allocations: InvoiceTimeEntryAllocation[],
  timeEntries: TimeEntry[],
): ResolvedInvoicePdfBilling {
  const lineItemById = new Map(lineItems.map(item => [item.id, item]));
  const entryById = new Map(timeEntries.map(entry => [entry.id, entry]));
  const allocationsByLine = new Map<string, InvoiceTimeEntryAllocation[]>();
  const seenLineEntries = new Set<string>();

  for (const allocation of allocations) {
    const lineItem = lineItemById.get(allocation.line_item_id);
    if (!lineItem || lineItem.item_type !== 'hourly') {
      throw new InvoicePdfIntegrityError('An invoice allocation points to a missing or non-hourly line item.');
    }
    const duplicateKey = `${allocation.line_item_id}:${allocation.time_entry_id}`;
    if (seenLineEntries.has(duplicateKey)) {
      throw new InvoicePdfIntegrityError('A time session is duplicated within an hourly line item.');
    }
    seenLineEntries.add(duplicateKey);
    const grouped = allocationsByLine.get(allocation.line_item_id) ?? [];
    grouped.push(allocation);
    allocationsByLine.set(allocation.line_item_id, grouped);
  }

  const resolvedAllocations: ResolvedInvoicePdfAllocation[] = [];
  const occupiedSlices = new Map<string, Array<{ start: number; end: number }>>();

  const resolvedLineItems = lineItems.map((lineItem): InvoicePdfLineItem => {
    if (lineItem.item_type !== 'hourly') return fixedLineItem(lineItem);

    const lineAllocations = allocationsByLine.get(lineItem.id) ?? [];
    if (lineAllocations.length === 0) return customHourlyLineItem(lineItem);

    const lineResolved: ResolvedInvoicePdfAllocation[] = [];
    for (const allocation of lineAllocations) {
      const timeEntry = entryById.get(allocation.time_entry_id);
      if (!timeEntry || timeEntry.end_time === null) {
        throw new InvoicePdfIntegrityError('An hourly allocation points to a missing or unfinished time session.');
      }

      const hours = Number(allocation.allocated_hours);
      const amount = Number(allocation.allocated_amount);
      const startOffsetHours = Number(allocation.start_offset_hours ?? 0);
      const hourlyRate = Number(timeEntry.hourly_rate);
      const workedHours = getWorkedHours(timeEntry);

      if (![hours, amount, startOffsetHours, hourlyRate, workedHours].every(Number.isFinite)) {
        throw new InvoicePdfIntegrityError('An hourly allocation contains a non-numeric billing value.');
      }
      if (hours <= 0 || amount < 0 || startOffsetHours < 0 || hourlyRate <= 0) {
        throw new InvoicePdfIntegrityError('An hourly allocation contains an invalid billing value.');
      }
      if (startOffsetHours + hours > workedHours + HOURS_EPSILON) {
        throw new InvoicePdfIntegrityError('An hourly allocation extends beyond its tracked session.');
      }
      if (Math.abs(toCents(hours * hourlyRate) - toCents(amount)) > 1) {
        throw new InvoicePdfIntegrityError('An hourly allocation amount disagrees with its session rate.');
      }

      const occupied = occupiedSlices.get(timeEntry.id) ?? [];
      const endOffsetHours = startOffsetHours + hours;
      if (occupied.some(slice => (
        startOffsetHours < slice.end - HOURS_EPSILON
        && endOffsetHours > slice.start + HOURS_EPSILON
      ))) {
        throw new InvoicePdfIntegrityError('A time session is billed more than once on the same invoice.');
      }
      occupied.push({ start: startOffsetHours, end: endOffsetHours });
      occupiedSlices.set(timeEntry.id, occupied);

      lineResolved.push({
        lineItemId: lineItem.id,
        timeEntry,
        startOffsetHours,
        hours,
        amount,
        hourlyRate,
      });
    }

    const allocatedCents = lineResolved.reduce((sum, allocation) => sum + toCents(allocation.amount), 0);
    if (allocatedCents !== toCents(Number(lineItem.amount) || 0)) {
      throw new InvoicePdfIntegrityError('Hourly allocation totals do not match the invoice line amount.');
    }

    const breakdownByRate = new Map<number, InvoicePdfRateBreakdown>();
    for (const allocation of lineResolved) {
      const existing = breakdownByRate.get(allocation.hourlyRate) ?? {
        hourlyRate: allocation.hourlyRate,
        hours: 0,
        amount: 0,
      };
      existing.hours += allocation.hours;
      existing.amount += allocation.amount;
      breakdownByRate.set(allocation.hourlyRate, existing);
    }
    const rateBreakdown = [...breakdownByRate.values()]
      .sort((a, b) => a.hourlyRate - b.hourlyRate)
      .map(item => ({
        ...item,
        amount: Math.round(item.amount * 100) / 100,
      }));

    resolvedAllocations.push(...lineResolved);
    return {
      ...lineItem,
      quantity: lineResolved.reduce((sum, allocation) => sum + allocation.hours, 0),
      rateLabel: rateBreakdown.length === 1 ? money(rateBreakdown[0].hourlyRate) : 'Mixed',
      allocationStatus: 'exact',
      rateBreakdown,
    };
  });

  return { lineItems: resolvedLineItems, allocations: resolvedAllocations };
}
