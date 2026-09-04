import type { InvoiceLineItem, InvoiceStatus } from '@/lib/types';

/**
 * Which canvas the document is drawn on. `dark` is the brand's own (the
 * website, the portal and the emails) and is what screens get; `paper` is the
 * same layout on white for anyone who prints or files a copy.
 */
export type InvoicePdfTheme = 'dark' | 'paper';

export interface InvoicePdfRateBreakdown {
  hourlyRate: number;
  hours: number;
  amount: number;
}

export interface InvoicePdfLineItem extends InvoiceLineItem {
  /** Exact mapped hours. Null means the hourly row is intentionally custom. */
  quantity: number | null;
  /** A formatted dollar rate, "Mixed", or "Custom". */
  rateLabel: string;
  allocationStatus: 'exact' | 'custom';
  rateBreakdown: InvoicePdfRateBreakdown[];
}

/**
 * Per-invoice rendering toggles. Required elements (parties, items table,
 * totals, dates) are always rendered; these flags only gate optional/decorative
 * pieces. Defaults are all `true` so the document looks identical to the
 * curated design unless the user opts something out.
 */
export interface InvoicePdfOptions {
  showLogo: boolean;
  /** Retired: the page no longer draws a top bar. Kept because the key is
   *  persisted in projects.invoice_pdf_options and older rows carry it. */
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
  hourlyRate: number;
  amount: number;
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
  /** The lockup drawn for dark chrome, used on the dark canvas. Falls back to logoUrl. */
  logoDarkUrl: string | null;

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
  lineItems: InvoicePdfLineItem[];

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
