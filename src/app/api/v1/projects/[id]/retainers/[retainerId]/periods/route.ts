import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moneyRpcError, retainerInProject } from '@/lib/api/money-api';
import { generateRetainerPeriod } from '@/lib/supabase/queries';
import { calendarDate } from '@/lib/schemas/shared';

export const dynamic = 'force-dynamic';

const generatePeriodSchema = z.object({ period_start: calendarDate }).strict();

/**
 * Drafts the invoice for one billing period now (Billing > Retainers,
 * Create draft), as the daily job would on its date. period_start is a
 * period's first day (GET .../retainers/due-periods lists the due ones). A
 * period skipped earlier is drafted; one already on an invoice is 409.
 * Answers the draft invoice.
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const retainer = await retainerInProject(supabase, params.id, params.retainerId);
  const { period_start } = body as z.infer<typeof generatePeriodSchema>;
  let invoice;
  try {
    invoice = await generateRetainerPeriod(supabase, retainer.id, period_start);
  } catch (error) {
    throw moneyRpcError(error as { code?: string; message: string }, 'Retainer');
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/retainers/${retainer.id}/periods`,
    entityType: 'invoice',
    entityId: invoice.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: invoice,
    statusCode: 201,
  });
  return created(invoice);
}, { schema: generatePeriodSchema, permission: 'invoices.manage' });
