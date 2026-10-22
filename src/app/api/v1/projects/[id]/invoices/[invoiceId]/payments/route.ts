import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { recordInvoicePaymentSchema } from '@/lib/schemas';
import { logAudit } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { runDispatch } from '@/lib/webhooks/dispatch';
import {
  invoiceInProject,
  invoicePaymentState,
  paymentRuleError,
  serializePayment,
} from '@/lib/api/invoice-payments';

export const dynamic = 'force-dynamic';

export const GET = withApi(async ({ supabase, params }) => {
  const state = await invoicePaymentState(supabase, params.id, params.invoiceId);
  const { data, error } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('invoice_id', params.invoiceId)
    .is('deleted_at', null)
    .order('paid_date')
    .order('created_at');
  if (error) throw error;
  return success({ invoice: state, payments: (data ?? []).map(serializePayment) });
}, { permission: 'invoices.read' });

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  await invoiceInProject(supabase, params.id, params.invoiceId);
  const payment = body as ReturnType<typeof recordInvoicePaymentSchema.parse>;
  const { data, error } = await supabase.rpc('record_invoice_payment', {
    p_invoice_id: params.invoiceId,
    p_payment: { ...payment, recorded_via: 'api', api_key_id: apiKeyId, created_by: teamMemberId },
  });
  const ruleError = paymentRuleError(error);
  if (ruleError) throw ruleError;
  if (error) throw error;
  const result = data as { payment: Record<string, unknown>; replayed: boolean };
  const response = {
    payment: serializePayment(result.payment),
    replayed: result.replayed,
    invoice: await invoicePaymentState(supabase, params.id, params.invoiceId),
  };

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/invoices/${params.invoiceId}/payments`,
    entityType: 'invoice_payment',
    entityId: response.payment.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: response,
    statusCode: result.replayed ? 200 : 201,
  });
  if (result.replayed) return success(response);
  // The status change (if any) queued webhook events; deliver them now.
  afterResponse('webhook dispatch', () => runDispatch());
  return created(response);
}, { schema: recordInvoicePaymentSchema, permission: 'invoices.record_payments' });
