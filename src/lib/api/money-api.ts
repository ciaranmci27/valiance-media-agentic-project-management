import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { hourApprovalsExist } from '@/lib/finance/finance-views';
import { fetchBusinessSettings, patchBusinessSettings } from '@/lib/supabase/queries';
import type { BusinessSettings } from '@/lib/types';
import { ApiError, badRequest, conflict, moduleOff, notFound } from './errors';

/**
 * Billing and money over the API: retainers, a project's billing plan,
 * the company's invoice details and the hour approvals switch.
 *
 * The retainer and billing plan functions (save_project_retainer,
 * schedule_retainer_amount, generate_retainer_period,
 * save_project_billing_plan) trust the service role and check
 * invoices.manage and project reach only for a signed-in member. A v1 route
 * runs as the service role, so withApi is the gate: invoices.manage on the
 * key and the member's api channel, and the project in params.id within
 * reach. A retainer is then looked up inside that project, so a key that
 * reaches one project never changes another's.
 *
 * Revenue splits (set_retainer_shares, set_invoice_line_shares, shares on a
 * new retainer) need compensation.manage, which is not an API scope, so the
 * API takes none of them.
 */

/** A database refusal from one of the money functions, as the API answers it. */
export function moneyRpcError(error: { code?: string; message: string }, resource: string): Error {
  if (/not found/i.test(error.message)) return notFound(resource);
  if (/already on an invoice/i.test(error.message)) return conflict(error.message);
  // RAISE EXCEPTION (P0001), a check constraint (23514), a bad value (22xxx)
  // or a missing member (23503): the request's fault, said in the database's words.
  if (error.code === 'P0001' || error.code === '23514' || error.code === '23503' || error.code?.startsWith('22')) {
    return badRequest(error.message);
  }
  return error as Error;
}

/** The live retainer, inside this project, or 404 (one in another project reads the same). */
export async function retainerInProject(service: SupabaseClient, projectId: string, retainerId: string) {
  const { data, error } = await service
    .from('project_retainers')
    .select('*')
    .eq('id', retainerId)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Retainer');
  return data as Record<string, unknown> & { id: string; project_id: string };
}

// -- Company invoice details and hour approvals (business_settings) --------

/** The "From" block, terms and notes every invoice PDF carries (Settings > Billing > Invoice details). */
export const INVOICE_DETAIL_FIELDS = [
  'business_name', 'business_address', 'business_email', 'business_phone',
  'payment_terms', 'payment_instructions', 'default_invoice_notes',
] as const;
export type InvoiceDetailField = typeof INVOICE_DETAIL_FIELDS[number];
export type InvoiceDetails = Pick<BusinessSettings, InvoiceDetailField>;

/** Invoice details mean something only with Client invoicing on (the app hides the section otherwise). */
export function assertInvoiceDetailsOn(access: AccessContext): void {
  if (!isModuleEnabled(access, 'billing')) throw moduleOff('billing');
}

/** Hour approvals exist only with Time tracking and Client invoicing or Team pay on (the app hides the switch otherwise). */
export function assertHourApprovalsOn(access: AccessContext): void {
  if (hourApprovalsExist(access)) return;
  throw moduleOff(isModuleEnabled(access, 'time') ? 'billing' : 'time');
}

async function businessSettingsRow(service: SupabaseClient): Promise<BusinessSettings> {
  const row = await fetchBusinessSettings(service);
  // The row is made with the schema; a workspace without it has nothing to show.
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Business settings not found', { reason: 'no_business_settings' });
  return row;
}

export function invoiceDetailsOf(row: BusinessSettings): InvoiceDetails {
  return Object.fromEntries(INVOICE_DETAIL_FIELDS.map((field) => [field, row[field]])) as InvoiceDetails;
}

export async function readInvoiceDetails(service: SupabaseClient) {
  const row = await businessSettingsRow(service);
  return { before: row, details: invoiceDetailsOf(row) };
}

/** Patches the business row the way the app's Save does, and answers the fields before and after. */
export async function patchInvoiceDetails(service: SupabaseClient, updates: Partial<InvoiceDetails>) {
  const before = await businessSettingsRow(service);
  const after = await patchBusinessSettings(service, before.id, updates);
  return { before: invoiceDetailsOf(before), after: invoiceDetailsOf(after) };
}

/** Whether people's finished hours approve as logged (true, the default) or wait for review. Agent hours always wait. */
export async function readHourApprovals(service: SupabaseClient) {
  const row = await businessSettingsRow(service);
  return { auto_approve_human_hours: row.auto_approve_human_hours ?? true };
}

export async function setHourApprovals(service: SupabaseClient, autoApprove: boolean) {
  const before = await businessSettingsRow(service);
  const after = await patchBusinessSettings(service, before.id, { auto_approve_human_hours: autoApprove });
  return {
    before: { auto_approve_human_hours: before.auto_approve_human_hours ?? true },
    after: { auto_approve_human_hours: after.auto_approve_human_hours ?? true },
  };
}
