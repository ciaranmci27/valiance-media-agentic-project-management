import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moneyRpcError, retainerInProject } from '@/lib/api/money-api';
import { scheduleRetainerAmount } from '@/lib/supabase/queries';
import { calendarDate } from '@/lib/schemas/shared';

export const dynamic = 'force-dynamic';

const scheduleAmountSchema = z.object({
  amount: z.number().min(0),
  effective_date: calendarDate,
}).strict();

/**
 * Schedules the retainer's amount from a date (Billing > Retainers, Schedule
 * a new amount). An amount already set for that date is replaced; earlier
 * amounts and periods already invoiced stay as they are.
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const retainer = await retainerInProject(supabase, params.id, params.retainerId);
  const { amount, effective_date } = body as z.infer<typeof scheduleAmountSchema>;
  let saved;
  try {
    saved = await scheduleRetainerAmount(supabase, retainer.id, amount, effective_date);
  } catch (error) {
    throw moneyRpcError(error as { code?: string; message: string }, 'Retainer');
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/retainers/${retainer.id}/amounts`,
    entityType: 'project_retainer_amount',
    entityId: saved.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: saved,
    statusCode: 201,
  });
  return created(saved);
}, { schema: scheduleAmountSchema, permission: 'invoices.manage' });
