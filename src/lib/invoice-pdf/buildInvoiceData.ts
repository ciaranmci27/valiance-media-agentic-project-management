import type {
  Project, ProjectInvoice, Contact, BusinessSettings,
  TimeEntry, TeamMember, InvoiceLineItem,
} from '@/lib/types';
import { ensureLineItems, lineItemsTotal, paidHourlyLineItemTotal, unpaidHoursByEntry } from '@/lib/invoice-utils';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { siteConfig } from '@/site-config';
import type { InvoicePdfData, InvoicePdfOptions, InvoicePdfTimeLogEntry } from './types';
import { DEFAULT_INVOICE_PDF_OPTIONS } from './types';

interface BuildInvoiceDataInput {
  invoice: ProjectInvoice;
  project: Project | undefined;
  primaryContact: Contact | undefined;
  businessSettings: BusinessSettings | null;
  /** Logged-in user's display name — rendered under the business name in the From block. */
  senderName: string;
  /** Absolute URL to the logo, or a relative path the PDF can resolve. */
  logoUrl: string;
  /** Absolute URL to the client portal — null/undefined when not enabled. */
  portalUrl?: string | null;
  /** Optional per-invoice rendering toggles. Falls back to all-on. */
  options?: Partial<InvoicePdfOptions>;
  /** All time entries for the project, used to build the optional time-logs page.
   *  Pass an empty array (or omit) to skip the time-logs page entirely. */
  timeEntries?: TimeEntry[];
  /** Project invoices, used to allocate the optional time-log page through the
   *  same FIFO paid-hours pool as invoice generation. */
  projectInvoices?: ProjectInvoice[];
  /** Team members, used to look up display names for each entry's member_id.
   *  Loosened to `id`/`name` so portal callers (which only fetch those columns)
   *  don't have to cast through full TeamMember rows. */
  team?: Pick<TeamMember, 'id' | 'name'>[];
}

/**
 * Pure transform from app state → PDF-ready data. No I/O, no env reads.
 * Falls back gracefully so a fresh install with no business_settings or
 * project billing fields still produces a sensible PDF.
 */
export function buildInvoiceData({
  invoice,
  project,
  primaryContact,
  businessSettings,
  senderName,
  logoUrl,
  portalUrl,
  options,
  timeEntries,
  projectInvoices,
  team,
}: BuildInvoiceDataInput): InvoicePdfData {
  const lineItems = ensureLineItems(invoice);
  const subtotal = lineItemsTotal(lineItems);
  const taxableSubtotal = lineItems
    .filter(li => li.item_type !== 'reimbursement')
    .reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  const taxRate = project?.tax_rate ?? null;
  const taxAmount = taxRate != null ? Math.round(taxableSubtotal * (taxRate / 100) * 100) / 100 : 0;
  const total = subtotal + taxAmount;

  const business = {
    name: businessSettings?.business_name?.trim() || siteConfig.name,
    senderName: senderName.trim(),
    address: businessSettings?.business_address ?? '',
    email: businessSettings?.business_email ?? '',
    phone: businessSettings?.business_phone ?? '',
  };

  // Resolve Bill To from project overrides, falling back to the primary contact.
  const billToAddress = project?.billing_address?.trim() || '';
  const billToEmail = project?.billing_email?.trim() || primaryContact?.email || '';
  const billTo = {
    name: primaryContact?.name ?? '',
    company: primaryContact?.company ?? '',
    address: billToAddress,
    email: billToEmail,
  };

  const notes = invoice.description?.trim() || businessSettings?.default_invoice_notes?.trim() || '';
  const paymentInstructions = businessSettings?.payment_instructions?.trim() || '';
  const paymentTerms = businessSettings?.payment_terms?.trim() || 'Upon Receipt';

  const projectHourlyRate = project?.hourly_tracking ? (project?.hourly_rate ?? null) : null;
  const timeLogEntries = buildTimeLogEntries({
    invoice,
    lineItems,
    timeEntries: timeEntries ?? [],
    projectInvoices: projectInvoices ?? [],
    team: team ?? [],
    hourlyRate: projectHourlyRate,
  });

  return {
    brandColor: siteConfig.colors.brand[600],
    logoUrl,
    business,
    billTo,
    invoiceNumber: invoice.invoice_number,
    status: invoice.status,
    issueDate: invoice.date,
    dueDate: invoice.due_date,
    paidDate: invoice.paid_date,
    paymentTerms,
    lineItems,
    projectHourlyRate,
    subtotal,
    taxRate,
    taxAmount,
    total,
    notes,
    paymentInstructions,
    portalUrl: portalUrl ?? null,
    generatedAt: new Date().toISOString(),
    options: { ...DEFAULT_INVOICE_PDF_OPTIONS, ...(options ?? {}) },
    timeLogEntries,
  };
}

// ── Time log derivation ────────────────────────────────────────────────

/** YYYY-MM-DD in local time for an ISO datetime. Matches the convention used
 *  elsewhere (e.g. `formatUnpaidHoursDescription`'s MM/DD/YYYY parse). */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse "MM/DD/YYYY" → "YYYY-MM-DD". Returns null on malformed input. */
function mdyToYmd(mdy: string): string | null {
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

/**
 * Pull the YYYY-MM-DD start/end span from an hourly line item. Tries explicit
 * service dates first (treating a single-bound item as a single-day range to
 * match `spreadLineItem`'s convention), then falls back to parsing the
 * description that the unpaid-hours roll-up writes
 * ("X hours worked between MM/DD/YYYY and MM/DD/YYYY"). Returns null when no
 * usable range can be determined.
 */
function rangeForHourlyLineItem(li: InvoiceLineItem): { start: string; end: string } | null {
  const rawStart = li.service_start_date || li.service_end_date;
  const rawEnd = li.service_end_date || li.service_start_date;
  if (rawStart && rawEnd) {
    return rawStart <= rawEnd
      ? { start: rawStart, end: rawEnd }
      : { start: rawEnd, end: rawStart };
  }
  const m = li.description.match(/between\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+and\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (m) {
    const start = mdyToYmd(m[1]);
    const end = mdyToYmd(m[2]);
    if (start && end) {
      return start <= end ? { start, end } : { start: end, end: start };
    }
  }
  return null;
}

function invoiceTimestamp(inv: ProjectInvoice): number {
  const created = Date.parse(inv.created_at);
  if (Number.isFinite(created)) return created;
  const dated = Date.parse(`${inv.date}T00:00:00`);
  return Number.isFinite(dated) ? dated : 0;
}

function priorPaidInvoicesForTimeLog(
  invoice: ProjectInvoice,
  projectInvoices: ProjectInvoice[],
): ProjectInvoice[] {
  const currentTs = invoiceTimestamp(invoice);
  return projectInvoices.filter((candidate) => {
    if (candidate.id === invoice.id) return false;
    if (candidate.project_id !== invoice.project_id) return false;
    if (candidate.status !== 'paid') return false;
    if (currentTs <= 0) return true;
    const candidateTs = invoiceTimestamp(candidate);
    return candidateTs > 0 ? candidateTs < currentTs : true;
  });
}

type ClosedSegment = { startMs: number; endMs: number };

function closedSegmentsForEntry(entry: TimeEntry): ClosedSegment[] {
  const segments = entry.segments?.length
    ? entry.segments
    : entry.end_time
      ? [{ start: entry.start_time, end: entry.end_time }]
      : [];

  return segments
    .filter((seg): seg is { start: string; end: string } => seg.end !== null)
    .map(seg => ({
      startMs: new Date(seg.start).getTime(),
      endMs: new Date(seg.end).getTime(),
    }))
    .filter(seg => Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs) && seg.endMs > seg.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

function timeAtWorkedOffset(segments: ClosedSegment[], offsetHours: number): number {
  const targetMs = Math.max(0, offsetHours) * 3_600_000;
  let walkedMs = 0;
  for (const segment of segments) {
    const durationMs = segment.endMs - segment.startMs;
    if (walkedMs + durationMs >= targetMs) {
      return segment.startMs + Math.max(0, targetMs - walkedMs);
    }
    walkedMs += durationMs;
  }
  return segments[segments.length - 1]?.endMs ?? Date.now();
}

function workedSliceRange(
  entry: TimeEntry,
  startOffsetHours: number,
  durationHours: number,
): { startIso: string; endIso: string } {
  const segments = closedSegmentsForEntry(entry);
  if (segments.length === 0) {
    return {
      startIso: entry.start_time,
      endIso: entry.end_time ?? entry.start_time,
    };
  }

  const totalHours = segments.reduce((sum, segment) => sum + ((segment.endMs - segment.startMs) / 3_600_000), 0);
  const safeStart = Math.min(Math.max(0, startOffsetHours), totalHours);
  const safeEnd = Math.min(totalHours, safeStart + Math.max(0, durationHours));
  const startMs = timeAtWorkedOffset(segments, safeStart);
  const endMs = timeAtWorkedOffset(segments, safeEnd);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(Math.max(startMs, endMs)).toISOString(),
  };
}

const HOURS_EPSILON = 0.000001;

function buildTimeLogEntries({
  invoice,
  lineItems,
  timeEntries,
  projectInvoices,
  team,
  hourlyRate,
}: {
  invoice: ProjectInvoice;
  lineItems: InvoiceLineItem[];
  timeEntries: TimeEntry[];
  projectInvoices: ProjectInvoice[];
  team: Pick<TeamMember, 'id' | 'name'>[];
  hourlyRate: number | null;
}): InvoicePdfTimeLogEntry[] {
  const hourlyItems = lineItems
    .filter(li => li.item_type === 'hourly')
    .map(li => ({ lineItem: li, range: rangeForHourlyLineItem(li) }))
    .filter((item): item is { lineItem: InvoiceLineItem; range: { start: string; end: string } } => item.range !== null);

  if (hourlyItems.length === 0 || timeEntries.length === 0) return [];

  const memberById = new Map(team.map(m => [m.id, m.name] as const));
  const finalizedEntries = [...timeEntries]
    .filter(te => te.end_time !== null)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  if (finalizedEntries.length === 0) return [];

  const entryHours = new Map(finalizedEntries.map(te => [te.id, getWorkedHours(te)] as const));
  const priorPaidPool = hourlyRate && hourlyRate > 0
    ? paidHourlyLineItemTotal(priorPaidInvoicesForTimeLog(invoice, projectInvoices))
    : 0;
  const initialBillableByEntry = hourlyRate && hourlyRate > 0
    ? unpaidHoursByEntry(
        finalizedEntries.map(te => ({ id: te.id, hours: entryHours.get(te.id) ?? 0 })),
        priorPaidPool,
        hourlyRate,
      )
    : new Map(finalizedEntries.map(te => [te.id, entryHours.get(te.id) ?? 0] as const));
  const remainingByEntry = new Map(initialBillableByEntry);

  const entries: InvoicePdfTimeLogEntry[] = [];
  let allocationIndex = 0;

  for (const { lineItem, range } of hourlyItems) {
    const targetHours = hourlyRate && hourlyRate > 0
      ? (Number(lineItem.amount) || 0) / hourlyRate
      : Number.POSITIVE_INFINITY;
    let allocatedHours = 0;

    for (const te of finalizedEntries) {
      if (allocatedHours + HOURS_EPSILON >= targetHours) break;

      const dayKey = localDayKey(te.start_time);
      if (!dayKey || dayKey < range.start || dayKey > range.end) continue;

      const remaining = remainingByEntry.get(te.id) ?? 0;
      if (remaining <= HOURS_EPSILON) continue;

      const takeHours = Math.min(remaining, targetHours - allocatedHours);
      if (takeHours <= HOURS_EPSILON) continue;

      const totalHours = entryHours.get(te.id) ?? 0;
      const initialBillableHours = initialBillableByEntry.get(te.id) ?? 0;
      const alreadyAllocatedFromEntry = initialBillableHours - remaining;
      const paidPrefixHours = Math.max(0, totalHours - initialBillableHours);
      const slice = workedSliceRange(te, paidPrefixHours + alreadyAllocatedFromEntry, takeHours);
      const sliceDayKey = localDayKey(slice.startIso) || dayKey;

      entries.push({
        id: `${te.id}:${allocationIndex}`,
        dayKey: sliceDayKey,
        startIso: slice.startIso,
        endIso: slice.endIso,
        hours: takeHours,
        description: te.description ?? '',
        memberName: memberById.get(te.member_id) ?? '',
      });

      allocationIndex += 1;
      allocatedHours += takeHours;
      remainingByEntry.set(te.id, remaining - takeHours);
    }
  }

  entries.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return entries;
}
