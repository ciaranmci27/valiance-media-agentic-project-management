import { ensureLineItems } from './invoice-utils';
import type { ProjectInvoice } from './types';

/**
 * Invoice totals and payments as the database rules them
 * (20261018205406_invoice_payments.sql). Shared by the invoices panel, the
 * portal and the finance figures.
 */

const toCents = (value: number) => Math.round((Number(value) || 0) * 100);

/**
 * Tax at a rate (percent, two decimals as projects store it) on a taxable
 * amount, in whole cents rounded half away from zero, exactly as SQL's
 * ROUND(taxable * rate / 100, 2) does it.
 */
export function taxOn(taxable: number, taxRate: number | null | undefined): number {
  if (taxRate == null) return 0;
  const scaled = toCents(taxable) * Math.round(Number(taxRate) * 100);
  const cents = Math.floor((Math.abs(scaled) + 5000) / 10000);
  return (Math.sign(scaled) * cents) / 100;
}

/** Tax on an invoice as the PDF adds it: the project rate on every line but reimbursements. */
export function invoiceTaxAmount(invoice: Pick<ProjectInvoice, 'id' | 'amount' | 'invoice_type' | 'line_items'>, taxRate: number | null | undefined): number {
  if (taxRate == null) return 0;
  const taxableCents = ensureLineItems(invoice as ProjectInvoice)
    .filter((line) => line.item_type !== 'reimbursement')
    .reduce((sum, line) => sum + toCents(line.amount), 0);
  return taxOn(taxableCents / 100, taxRate);
}

/** What the client owes for the invoice: its amount plus tax (invoice_total in SQL). */
export function invoiceTotal(invoice: Pick<ProjectInvoice, 'id' | 'amount' | 'invoice_type' | 'line_items'>, taxRate: number | null | undefined): number {
  return (toCents(invoice.amount) + toCents(invoiceTaxAmount(invoice, taxRate))) / 100;
}

export function invoicePaidTotal(invoice: Pick<ProjectInvoice, 'payments'>): number {
  return (invoice.payments ?? []).reduce((sum, payment) => sum + toCents(payment.amount), 0) / 100;
}

/** Owed and not yet paid (never below 0). */
export function invoiceOutstanding(invoice: ProjectInvoice, taxRate: number | null | undefined): number {
  return Math.max(0, toCents(invoiceTotal(invoice, taxRate)) - toCents(invoicePaidTotal(invoice))) / 100;
}

/** Sent or overdue with some, but not all, of the total paid. */
export function isPartiallyPaid(invoice: ProjectInvoice, taxRate: number | null | undefined): boolean {
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') return false;
  const paid = toCents(invoicePaidTotal(invoice));
  return paid > 0 && paid < toCents(invoiceTotal(invoice, taxRate));
}

/**
 * The invoice amount (before tax) received, spread over the days payments
 * arrived. A paid invoice counts its whole amount, as it always has; a part
 * payment counts its share of the amount. Without loaded payments (demo
 * data), a paid invoice counts on its paid date.
 */
export function invoiceAmountReceived(
  invoice: ProjectInvoice,
  taxRate: number | null | undefined,
): Array<{ date: string; amount: number }> {
  const amount = Number(invoice.amount) || 0;
  const payments = invoice.payments ?? [];
  const paid = invoicePaidTotal(invoice);
  if (payments.length === 0 || paid <= 0) {
    return invoice.status === 'paid' && invoice.paid_date ? [{ date: invoice.paid_date.slice(0, 10), amount }] : [];
  }
  const factor = invoice.status === 'paid' ? amount / paid : amount / Math.max(invoiceTotal(invoice, taxRate), paid);
  return payments.map((payment) => ({
    date: payment.paid_date.slice(0, 10),
    amount: Math.round(Number(payment.amount) * factor * 100) / 100,
  }));
}

/** The invoice amount (before tax) received so far. */
export function invoiceAmountPaid(invoice: ProjectInvoice, taxRate: number | null | undefined): number {
  return invoiceAmountReceived(invoice, taxRate).reduce((sum, part) => sum + toCents(part.amount), 0) / 100;
}

/**
 * The person-facing text of a payment rule the database refused (its errors
 * start with a code such as PAYMENT_RECORDED_ELSEWHERE), or null.
 */
export function parsePaymentRuleError(message: string | null | undefined): { code: string; text: string } | null {
  const match = /^((?:INVOICE|PAYMENT|EARNED_WORK)_[A-Z_]+): ([\s\S]*)$/.exec(message ?? '');
  return match ? { code: match[1], text: match[2] } : null;
}
