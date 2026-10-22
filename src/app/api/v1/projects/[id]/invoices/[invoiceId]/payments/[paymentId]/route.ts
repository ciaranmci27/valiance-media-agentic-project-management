import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
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

/**
 * Remove one payment an API key recorded. A payment recorded by hand in the
 * app is refused (409 PAYMENT_RECORDED_ELSEWHERE), and so is one whose
 * removal would un-pay an invoice with a paid-out revenue split (409
 * PAYMENT_SHARES_PAID_OUT).
 */
export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  await invoiceInProject(supabase, params.id, params.invoiceId);
  const { data: before, error: readError } = await supabase
    .from('invoice_payments')
    .select('*')
    .eq('id', params.paymentId)
    .eq('invoice_id', params.invoiceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) throw readError;
  if (!before) throw notFound('Payment');

  const { error } = await supabase.rpc('remove_invoice_payment', { p_payment_id: params.paymentId, p_recorded_via: 'api' });
  const ruleError = paymentRuleError(error);
  if (ruleError) throw ruleError;
  if (error) throw error;

  const response = {
    deleted: true,
    payment: serializePayment(before),
    invoice: await invoicePaymentState(supabase, params.id, params.invoiceId),
  };
  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${params.id}/invoices/${params.invoiceId}/payments/${params.paymentId}`,
    entityType: 'invoice_payment',
    entityId: params.paymentId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: response,
    statusCode: 200,
  });
  afterResponse('webhook dispatch', () => runDispatch());
  return success(response);
}, { permission: 'invoices.record_payments' });
