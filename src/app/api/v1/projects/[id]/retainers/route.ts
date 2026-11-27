import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moneyRpcError } from '@/lib/api/money-api';
import { fetchProjectRetainers, saveProjectRetainer } from '@/lib/supabase/queries';
import { calendarDate, nameText } from '@/lib/schemas/shared';
import { RETAINER_BILLING_TIMINGS } from '@/lib/types';

export const dynamic = 'force-dynamic';

const createRetainerSchema = z.object({
  name: nameText(),
  amount: z.number().min(0),
  start_date: calendarDate,
  billing_timing: z.enum(RETAINER_BILLING_TIMINGS).optional(),
  end_date: calendarDate.nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  lead_days: z.number().int().min(0).max(28).optional(),
  link_lines: z.array(z.object({ invoice_id: z.uuid(), line_item_id: z.string().min(1).max(200) }).strict()).max(500).optional(),
}).strict();

/**
 * The project's retainers with their dated amounts and handled periods
 * (generated or skipped), oldest first. Revenue splits are not included:
 * they need compensation.manage, which is not an API scope.
 */
export const GET = withApi(async ({ supabase, params }) => {
  const { retainers, amounts, periods } = await fetchProjectRetainers(supabase, params.id, false);
  return success({ retainers, amounts, periods });
}, { permission: 'invoices.read' });

/**
 * A new retainer on this project (Billing > Retainers, Create): its name,
 * first amount from start_date, timing and lead days. link_lines ties lines
 * already invoiced by hand to it, so those periods never draft again.
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const input = body as z.infer<typeof createRetainerSchema>;
  let saved;
  try {
    saved = await saveProjectRetainer(supabase, null, { ...input, project_id: params.id });
  } catch (error) {
    throw moneyRpcError(error as { code?: string; message: string }, 'Retainer');
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/retainers`,
    entityType: 'project_retainer',
    entityId: saved.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: saved,
    statusCode: 201,
  });
  return created(saved);
}, { schema: createRetainerSchema, permission: 'invoices.manage' });
