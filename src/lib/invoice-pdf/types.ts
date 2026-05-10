import type { InvoiceLineItem, InvoiceStatus } from '@/lib/types';

/**
 * Per-invoice rendering toggles. Required elements (parties, items table,
 * totals, dates) are always rendered; these flags only gate optional/decorative
 * pieces. Defaults are all `true` so the document looks identical to the
 * curated design unless the user opts something out.
 */
export interface InvoicePdfOptions {
  showLogo: boolean;
  showTopAccent: boolean;
  showStatusStamp: boolean;
  showSenderName: boolean;
  showLineCaptions: boolean;
  showPortalLink: boolean;
  showNotes: boolean;
  showPaymentInstructions: boolean;
  showFooter: boolean;
  /** Append a second page with the underlying time-entry log for hourly work.
   *  Off by default since older invoices and most clients won't expect it. */
  showTimeLogs: boolean;
}

export const DEFAULT_INVOICE_PDF_OPTIONS: InvoicePdfOptions = {
  showLogo: true,
  showTopAccent: true,
  showStatusStamp: true,
  showSenderName: true,
  showLineCaptions: true,
  showPortalLink: true,
  showNotes: true,
  showPaymentInstructions: true,
  showFooter: true,
  showTimeLogs: false,
};

/** A single time entry rendered on the optional time-logs page. */
export interface InvoicePdfTimeLogEntry {
  id: string;
  /** YYYY-MM-DD in local time, used for grouping rows by day. */
  dayKey: string;
  /** ISO datetime of the first segment's start. */
  startIso: string;
  /** ISO datetime of the last segment's end (always set; unfinalized entries are filtered out). */
  endIso: string;
  /** Decimal hours worked across all segments. */
  hours: number;
  description: string;
  /** Display name of the team member who logged the entry. Empty when unknown. */
  memberName: string;
}

/**
 * Self-contained data shape consumed by InvoiceDocument. Build this with
 * buildInvoiceData() so the PDF component itself stays a pure renderer.
 */
export interface InvoicePdfData {
  // Branding
  brandColor: string;
  logoUrl: string;

  // From (workspace business identity)
  business: {
    name: string;
    senderName: string; // logged-in user — appears under business name like "Bill To" pattern
    address: string;
    email: string;
    phone: string;
  };

  // Bill To (resolved from project + primary contact)
  billTo: {
    name: string;
    company: string;
    address: string;
    email: string;
  };

  // Invoice meta
  invoiceNumber: string;
  status: InvoiceStatus;
  issueDate: string;       // YYYY-MM-DD
  dueDate: string | null;  // YYYY-MM-DD
  paidDate: string | null; // YYYY-MM-DD
  paymentTerms: string;

  // Line items (subset shape we actually render)
  lineItems: InvoiceLineItem[];
  /** Project's hourly rate (null if non-hourly project). Used to derive
   *  Qty (= amount / rate) and Rate columns for hourly line items. */
  projectHourlyRate: number | null;

  // Money
  subtotal: number;
  taxRate: number | null; // percent (e.g., 8.5)
  taxAmount: number;
  total: number;

  // Optional, default-aware text content
  notes: string;               // per-invoice notes (or workspace default)
  paymentInstructions: string; // workspace-level
  /** Absolute URL to the project's client portal — null when not enabled. */
  portalUrl: string | null;

  // Generation timestamp (rendered in footer)
  generatedAt: string; // ISO

  // Per-invoice render toggles (logo, top bar, stamp, etc.)
  options: InvoicePdfOptions;

  /** Finalized time entries that fall within the invoice's hourly line-item
   *  date ranges. Sorted oldest-first. Empty when the invoice has no hourly
   *  line items, or when no entries match. The optional second page only
   *  renders when this is non-empty AND options.showTimeLogs is true. */
  timeLogEntries: InvoicePdfTimeLogEntry[];
}
