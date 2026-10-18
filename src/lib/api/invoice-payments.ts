import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, notFound } from './errors';
import { ensureLineItems } from '@/lib/invoice-utils';
import type { InvoiceLineItem, ProjectInvoice } from '@/lib/types';

/**
 * Payment rules live in SQL (20261018205406_invoice_payments.sql); their
 * errors start with a code. This maps each code to the status the API
 * answers with, keeping the code itself as error.code.
 */
const PAYMENT_ERROR_STATUS: Record<string, number> = {
  INVOICE_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  PAYMENT_FORBIDDEN: 403,
  PAYMENT_EXTERNAL_ID_CONFLICT: 409,
  PAYMENT_RECORDED_ELSEWHERE: 409,
  PAYMENT_SHARES_PAID_OUT: 409,
  INVOICE_NOT_PAYABLE: 422,
  PAYMENT_EXCEEDS_OUTSTANDING: 422,
  PAYMENT_INVALID: 422,
  EARNED_WORK_RANGE: 422,
};

/** The ApiError for a payment rule the database refused, or null for any other error. */
export function paymentRuleError(error: { message?: string } | null | undefined): ApiError | null {
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(error?.message ?? '');
  if (!match || !(match[1] in PAYMENT_ERROR_STATUS)) return null;
  return new ApiError(PAYMENT_ERROR_STATUS[match[1]], match[1], match[2]);
}

export interface ApiInvoicePayment {
  id: string;
  invoice_id: string;
  amount: number;
  paid_date: string;
  method: string | null;
  reference: string | null;
  external_id: string | null;
  recorded_via: 'app' | 'api';
  api_key_id: string | null;
  created_at: string;
}

export function serializePayment(row: Record<string, unknown>): ApiInvoicePayment {
  return {
    id: row.id as string,
    invoice_id: row.invoice_id as string,
    amount: Number(row.amount),
    paid_date: String(row.paid_date).slice(0, 10),
    method: (row.method as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    external_id: (row.external_id as string | null) ?? null,
    recorded_via: row.recorded_via as 'app' | 'api',
    api_key_id: (row.api_key_id as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

const cents = (value: number) => Math.round(value * 100);
const dollars = (value: number) => Math.round(value * 100) / 100;

/** Total owed and paid so far per invoice, from SQL (the rule POST checks against). */
export async function invoiceTotals(supabase: SupabaseClient, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return new Map<string, { total: number; paid_total: number }>();
  const { data, error } = await supabase.rpc('invoice_payment_totals', { p_invoice_ids: invoiceIds });
  if (error) throw error;
  const totals = (data ?? {}) as Record<string, { total: number | string; paid_total: number | string }>;
  return new Map(Object.entries(totals).map(([id, row]) => [id, { total: Number(row.total), paid_total: Number(row.paid_total) }]));
}

/** An invoice of the project, or 404. */
export async function invoiceInProject(supabase: SupabaseClient, projectId: string, invoiceId: string) {
  const { data, error } = await supabase
    .from('project_invoices')
    .select('id, project_id, status, amount, paid_date')
    .eq('id', invoiceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Invoice');
  return data as { id: string; project_id: string; status: string; amount: number; paid_date: string | null };
}

export interface ApiInvoiceLine {
  /** Stable within the invoice: the line id, "legacy:<invoice id>" or "balance:<invoice id>". */
  key: string;
  type: InvoiceLineItem['item_type'];
  description: string;
  amount: number;
  service_from: string | null;
  service_to: string | null;
  retainer_id: string | null;
}

/**
 * The invoice's lines, always summing to its amount: a line-less (legacy)
 * invoice gets the one line ensureLineItems builds, and lines that do not
 * add up get a fixed "balance" line for the difference.
 */
export function normalizedInvoiceLines(invoice: ProjectInvoice): ApiInvoiceLine[] {
  const lines: ApiInvoiceLine[] = ensureLineItems(invoice)
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((line) => ({
      key: line.id,
      type: line.item_type,
      description: line.description ?? '',
      amount: dollars(Number(line.amount) || 0),
      service_from: line.service_start_date ?? null,
      service_to: line.service_end_date ?? null,
      retainer_id: line.retainer_id ?? null,
    }));
  const gap = cents(Number(invoice.amount) || 0) - lines.reduce((sum, line) => sum + cents(line.amount), 0);
  if (gap !== 0) {
    lines.push({
      key: 'balance:' + invoice.id,
      type: 'fixed',
      description: 'Difference between the invoice amount and its lines',
      amount: gap / 100,
      service_from: null,
      service_to: null,
      retainer_id: null,
    });
  }
  return lines;
}

export function outstandingOf(totals: { total: number; paid_total: number } | undefined) {
  if (!totals) return 0;
  return Math.max(0, cents(totals.total) - cents(totals.paid_total)) / 100;
}

/** An invoice's payment state: status, paid_date, total owed, paid and outstanding. */
export async function invoicePaymentState(supabase: SupabaseClient, projectId: string, invoiceId: string) {
  const invoice = await invoiceInProject(supabase, projectId, invoiceId);
  const totals = (await invoiceTotals(supabase, [invoiceId])).get(invoiceId);
  return {
    id: invoice.id,
    status: invoice.status,
    paid_date: invoice.paid_date,
    total: totals?.total ?? Number(invoice.amount),
    paid_total: totals?.paid_total ?? 0,
    outstanding: outstandingOf(totals),
  };
}
