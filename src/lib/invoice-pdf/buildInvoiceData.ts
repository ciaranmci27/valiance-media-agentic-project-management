import type {
  Project, ProjectInvoice, Contact, BusinessSettings,
  TimeEntry, TeamMember, InvoiceLineItem,
} from '@/lib/types';
import { ensureLineItems, lineItemsTotal } from '@/lib/invoice-utils';
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

  const timeLogEntries = buildTimeLogEntries(lineItems, timeEntries ?? [], team ?? []);

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
    projectHourlyRate: project?.hourly_tracking ? (project?.hourly_rate ?? null) : null,
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

function buildTimeLogEntries(
  lineItems: InvoiceLineItem[],
  timeEntries: TimeEntry[],
  team: Pick<TeamMember, 'id' | 'name'>[],
): InvoicePdfTimeLogEntry[] {
  const ranges = lineItems
    .filter(li => li.item_type === 'hourly')
    .map(rangeForHourlyLineItem)
    .filter((r): r is { start: string; end: string } => r !== null);

  if (ranges.length === 0 || timeEntries.length === 0) return [];

  const memberById = new Map(team.map(m => [m.id, m.name] as const));

  const entries: InvoicePdfTimeLogEntry[] = [];
  for (const te of timeEntries) {
    if (te.end_time === null) continue;
    const dayKey = localDayKey(te.start_time);
    if (!dayKey) continue;
    const inRange = ranges.some(r => dayKey >= r.start && dayKey <= r.end);
    if (!inRange) continue;
    entries.push({
      id: te.id,
      dayKey,
      startIso: te.start_time,
      endIso: te.end_time,
      hours: getWorkedHours(te),
      description: te.description ?? '',
      memberName: memberById.get(te.member_id) ?? '',
    });
  }

  entries.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return entries;
}
