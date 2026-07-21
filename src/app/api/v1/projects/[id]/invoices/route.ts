import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createInvoiceSchema } from '@/lib/schemas';
import { badRequest } from '@/lib/api/errors';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';

function assertInvoiceTotal(invoice: { amount: number; line_items: Array<{ amount: number }> }) {
  const lineTotal = invoice.line_items.reduce((sum, item) => sum + item.amount, 0);
  if (Math.abs(Math.round(lineTotal * 100) - Math.round(invoice.amount * 100)) > 0) {
    throw badRequest('Invoice amount must equal the sum of its line items');
  }
}

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');
  let query = supabase
    .from('project_invoices')
    .select('*, invoice_time_entry_allocations(*)', { count: 'exact' })
    .eq('project_id', params.id);
  if (status) query = query.eq('status', status);

  const { data, count, error } = await query
    .order('date', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const invoices = (data || []).map(({ invoice_time_entry_allocations, ...invoice }) => ({
    ...invoice,
    time_allocations: invoice_time_entry_allocations || [],
  }));
  return paginated(invoices, { page, limit, total: count || 0 });
}, { permission: 'invoices.read' });

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { time_allocations, ...invoice } = body as ReturnType<typeof createInvoiceSchema.parse>;
  assertInvoiceTotal(invoice);

  const { data, error } = await supabase
    .rpc('save_project_invoice_with_allocations', {
      p_invoice_id: null,
      p_invoice: { ...invoice, project_id: params.id, created_by: teamMemberId },
      p_allocations: time_allocations,
    })
    .single();
  if (error && /invoice|allocation|time session/i.test(error.message)) throw badRequest(error.message);
  if (error) throw error;
  const saved = data as Record<string, unknown>;

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/invoices`,
    entityType: 'invoice',
    entityId: saved.id as string,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: saved,
    statusCode: 201,
  });
  return created({ ...saved, time_allocations });
}, { schema: createInvoiceSchema, permission: 'invoices.manage' });
