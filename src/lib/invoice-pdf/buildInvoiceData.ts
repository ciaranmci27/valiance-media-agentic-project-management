import type {
  Project, ProjectInvoice, Contact, BusinessSettings,
  TimeEntry, TeamMember, InvoiceLineItem, InvoiceTimeEntryAllocation,
} from '@/lib/types';
import {
  buildUnpaidHoursLineItem,
  ensureLineItems,
  lineItemsTotal,
  paidHourlyLineItemTotal,
} from '@/lib/invoice-utils';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { siteConfig } from '@/site-config';
import type { InvoicePdfData, InvoicePdfOptions, InvoicePdfTimeLogEntry } from './types';
import { DEFAULT_INVOICE_PDF_OPTIONS } from './types';
import {
  resolveInvoicePdfBilling,
  type ResolvedInvoicePdfAllocation,
} from './resolveInvoicePdfBilling';

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

  const storedAllocations = invoice.time_allocations ?? [];
  const effectiveAllocations = storedAllocations.length > 0
    ? storedAllocations
    : buildLegacyInvoiceAllocations({
        invoice,
        lineItems,
        timeEntries: timeEntries ?? [],
        projectInvoices: projectInvoices ?? [],
        fallbackRate: project?.hourly_tracking ? (project.hourly_rate ?? 0) : 0,
      });
  const billing = resolveInvoicePdfBilling(
    lineItems,
    effectiveAllocations,
    timeEntries ?? [],
  );
  const timeLogEntries = buildTimeLogEntries({
    allocations: billing.allocations,
    team: team ?? [],
  });

  return {
    brandColor: siteConfig.colors.brand[500],
    logoUrl,
    business,
    billTo,
    invoiceNumber: invoice.invoice_number,
    status: invoice.status,
    issueDate: invoice.date,
    dueDate: invoice.due_date,
    paidDate: invoice.paid_date,
    paymentTerms,
    lineItems: billing.lineItems,
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

function mdyToYmd(mdy: string): string | null {
  const match = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function rangeForHourlyLineItem(lineItem: InvoiceLineItem): { start: string; end: string } | null {
  const rawStart = lineItem.service_start_date || lineItem.service_end_date;
  const rawEnd = lineItem.service_end_date || lineItem.service_start_date;
  if (rawStart && rawEnd) {
    return rawStart <= rawEnd
      ? { start: rawStart, end: rawEnd }
      : { start: rawEnd, end: rawStart };
  }

  const match = lineItem.description.match(
    /between\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+and\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
  );
  if (!match) return null;
  const start = mdyToYmd(match[1]);
  const end = mdyToYmd(match[2]);
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function invoiceTimestamp(invoice: ProjectInvoice): number {
  const created = Date.parse(invoice.created_at);
  if (Number.isFinite(created)) return created;
  const dated = Date.parse(`${invoice.date}T00:00:00`);
  return Number.isFinite(dated) ? dated : 0;
}

function priorPaidInvoices(
  invoice: ProjectInvoice,
  projectInvoices: ProjectInvoice[],
): ProjectInvoice[] {
  const currentTimestamp = invoiceTimestamp(invoice);
  return projectInvoices.filter(candidate => {
    if (candidate.id === invoice.id || candidate.project_id !== invoice.project_id) return false;
    if (candidate.status !== 'paid') return false;
    if (currentTimestamp <= 0) return true;
    const candidateTimestamp = invoiceTimestamp(candidate);
    return candidateTimestamp > 0 ? candidateTimestamp < currentTimestamp : true;
  });
}

interface LegacyRemainingPortion {
  startOffsetHours: number;
  hours: number;
}

/**
 * Historical invoices predate persisted allocation rows. Reconstruct only
 * their preview mapping with the same FIFO inputs used when they were created.
 * New invoices never use this path because they always carry saved mappings.
 */
function buildLegacyInvoiceAllocations({
  invoice,
  lineItems,
  timeEntries,
  projectInvoices,
  fallbackRate,
}: {
  invoice: ProjectInvoice;
  lineItems: InvoiceLineItem[];
  timeEntries: TimeEntry[];
  projectInvoices: ProjectInvoice[];
  fallbackRate: number;
}): InvoiceTimeEntryAllocation[] {
  const finalizedEntries = [...timeEntries]
    .filter((entry): entry is TimeEntry & { end_time: string } => entry.end_time !== null)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (finalizedEntries.length === 0) return [];

  const unpaidDraft = buildUnpaidHoursLineItem(
    finalizedEntries.map(entry => ({
      id: entry.id,
      hours: getWorkedHours(entry),
      hourly_rate: entry.hourly_rate,
      start_time: entry.start_time,
      end_time: entry.end_time,
    })),
    paidHourlyLineItemTotal(priorPaidInvoices(invoice, projectInvoices)),
    fallbackRate,
  );
  if (!unpaidDraft) return [];

  let remainingByEntry = new Map<string, LegacyRemainingPortion>(
    unpaidDraft.allocations.map(allocation => [allocation.time_entry_id, {
      startOffsetHours: allocation.start_offset_hours,
      hours: allocation.allocated_hours,
    }]),
  );
  const reconstructed: InvoiceTimeEntryAllocation[] = [];

  for (const lineItem of lineItems) {
    if (lineItem.item_type !== 'hourly') continue;
    const range = rangeForHourlyLineItem(lineItem);
    let remainingCents = Math.round((Number(lineItem.amount) || 0) * 100);
    if (!range || remainingCents <= 0) continue;

    const candidateRemaining = new Map(
      [...remainingByEntry].map(([id, portion]) => [id, { ...portion }]),
    );
    const lineAllocations: InvoiceTimeEntryAllocation[] = [];

    for (const entry of finalizedEntries) {
      if (remainingCents <= 0) break;
      const dayKey = localDayKey(entry.start_time);
      if (!dayKey || dayKey < range.start || dayKey > range.end) continue;

      const portion = candidateRemaining.get(entry.id);
      const hourlyRate = Number(entry.hourly_rate ?? fallbackRate);
      if (!portion || portion.hours <= 0 || !Number.isFinite(hourlyRate) || hourlyRate <= 0) continue;

      const availableCents = Math.round(portion.hours * hourlyRate * 100);
      const allocatedCents = Math.min(availableCents, remainingCents);
      if (allocatedCents <= 0) continue;
      const allocatedHours = allocatedCents === availableCents
        ? portion.hours
        : allocatedCents / 100 / hourlyRate;

      lineAllocations.push({
        line_item_id: lineItem.id,
        time_entry_id: entry.id,
        start_offset_hours: portion.startOffsetHours,
        allocated_hours: allocatedHours,
        allocated_amount: allocatedCents / 100,
      });
      portion.startOffsetHours += allocatedHours;
      portion.hours = Math.max(0, portion.hours - allocatedHours);
      remainingCents -= allocatedCents;
    }

    // If historical data cannot explain the full saved line amount, leave the
    // line custom instead of presenting a partial or misleading time log.
    if (remainingCents === 0) {
      reconstructed.push(...lineAllocations);
      remainingByEntry = candidateRemaining;
    }
  }

  return reconstructed;
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
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const durationMs = segment.endMs - segment.startMs;
    const reachesTarget = walkedMs + durationMs > targetMs;
    const endsAtFinalBoundary = index === segments.length - 1 && walkedMs + durationMs >= targetMs;
    if (reachesTarget || endsAtFinalBoundary) {
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

function buildTimeLogEntries({
  allocations,
  team,
}: {
  allocations: ResolvedInvoicePdfAllocation[];
  team: Pick<TeamMember, 'id' | 'name'>[];
}): InvoicePdfTimeLogEntry[] {
  const memberById = new Map(team.map(m => [m.id, m.name] as const));
  return [...allocations]
    .sort((a, b) => (
      a.timeEntry.start_time.localeCompare(b.timeEntry.start_time)
      || a.startOffsetHours - b.startOffsetHours
    ))
    .map((allocation, index): InvoicePdfTimeLogEntry => {
      const slice = workedSliceRange(
        allocation.timeEntry,
        allocation.startOffsetHours,
        allocation.hours,
      );
      return {
        id: `${allocation.lineItemId}:${allocation.timeEntry.id}:${index}`,
        dayKey: localDayKey(slice.startIso) || localDayKey(allocation.timeEntry.start_time),
        startIso: slice.startIso,
        endIso: slice.endIso,
        hours: allocation.hours,
        hourlyRate: allocation.hourlyRate,
        amount: allocation.amount,
        description: allocation.timeEntry.description ?? '',
        memberName: memberById.get(allocation.timeEntry.member_id) ?? '',
      };
    });
}
