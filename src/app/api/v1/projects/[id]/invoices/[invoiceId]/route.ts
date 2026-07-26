import { after } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateInvoiceSchema } from '@/lib/schemas';
import { badRequest, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { runDispatch } from '@/lib/webhooks/dispatch';
import type { SupabaseClient } from '@supabase/supabase-js';

function assertInvoiceTotal(amount: number, lineItems: Array<{ amount: number }>) {
  const lineTotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  if (Math.round(lineTotal * 100) !== Math.round(amount * 100)) {
    throw badRequest('Invoice amount must equal the sum of its line items');
  }
}

async function fetchInvoice(supabase: SupabaseClient, projectId: string, invoiceId: string) {
  const { data, error } = await supabase
    .from('project_invoices')
    .select('*, invoice_time_entry_allocations(*)')
    .eq('id', invoiceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Invoice');
  return data;
}

export const GET = withApi(async ({ supabase, params }) => {
  const { invoice_time_entry_allocations, ...invoice } = await fetchInvoice(supabase, params.id, params.invoiceId);
  return success({ ...invoice, time_allocations: invoice_time_entry_allocations || [] });
}, { permission: 'invoices.read' });

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const before = await fetchInvoice(supabase, params.id, params.invoiceId);
  const { time_allocations, ...updates } = body as ReturnType<typeof updateInvoiceSchema.parse>;
  const amount = updates.amount ?? Number(before.amount);
  const lineItems = updates.line_items ?? before.line_items;
  assertInvoiceTotal(amount, lineItems);

  const { data, error } = await supabase
    .rpc('save_project_invoice_with_allocations', {
      p_invoice_id: params.invoiceId,
      p_invoice: updates,
      p_allocations: time_allocations === undefined ? null : time_allocations,
    })
    .single();
  if (error && /invoice|allocation|time session/i.test(error.message)) throw badRequest(error.message);
  if (error) throw error;
  const saved = data as Record<string, unknown>;

  const { data: allocations, error: allocationError } = await supabase
    .from('invoice_time_entry_allocations')
    .select('*')
    .eq('invoice_id', params.invoiceId);
  if (allocationError) throw allocationError;

  const result = { ...saved, time_allocations: allocations || [] };
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${params.id}/invoices/${params.invoiceId}`,
    entityType: 'invoice',
    entityId: params.invoiceId,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: result,
    statusCode: 200,
  });
  // Best-effort immediate delivery of any webhook event the DB trigger just
  // enqueued for this change.
  after(() => runDispatch().catch(() => {}));
  return success(result);
}, { schema: updateInvoiceSchema, permission: 'invoices.manage' });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const before = await fetchInvoice(supabase, params.id, params.invoiceId);
  const { error } = await supabase
    .from('project_invoices')
    .delete()
    .eq('id', params.invoiceId)
    .eq('project_id', params.id);
  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${params.id}/invoices/${params.invoiceId}`,
    entityType: 'invoice',
    entityId: params.invoiceId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });
  after(() => runDispatch().catch(() => {}));
  return success({ deleted: true });
}, { permission: 'invoices.manage' });
