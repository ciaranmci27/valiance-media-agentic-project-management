import type { Project, ProjectInvoice, Contact, BusinessSettings } from '@/lib/types';
import { ensureLineItems, lineItemsTotal } from '@/lib/invoice-utils';
import { siteConfig } from '@/site-config';
import type { InvoicePdfData, InvoicePdfOptions } from './types';
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
}: BuildInvoiceDataInput): InvoicePdfData {
  const lineItems = ensureLineItems(invoice);
  const subtotal = lineItemsTotal(lineItems);
  const taxRate = project?.tax_rate ?? null;
  const taxAmount = taxRate != null ? Math.round(subtotal * (taxRate / 100) * 100) / 100 : 0;
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
  };
}
