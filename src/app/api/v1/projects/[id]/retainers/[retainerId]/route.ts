import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moneyRpcError, retainerInProject } from '@/lib/api/money-api';
import { saveProjectRetainer } from '@/lib/supabase/queries';
import { calendarDate, nameText } from '@/lib/schemas/shared';
import { RETAINER_BILLING_TIMINGS } from '@/lib/types';

export const dynamic = 'force-dynamic';

const RETAINER_FIELDS = ['name', 'billing_timing', 'start_date', 'end_date', 'status', 'lead_days'] as const;

const updateRetainerSchema = z.object({
  name: nameText().optional(),
  billing_timing: z.enum(RETAINER_BILLING_TIMINGS).optional(),
  start_date: calendarDate.optional(),
  end_date: calendarDate.nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  lead_days: z.number().int().min(0).max(28).optional(),
}).strict().refine((value) => RETAINER_FIELDS.some((field) => value[field] !== undefined), {
  message: `Send at least one of: ${RETAINER_FIELDS.join(', ')}`,
});

/**
 * Edits a retainer (Billing > Retainers, Edit), pauses it (status paused)
 * or resumes it, or ends it (end_date: the last month prorates to it). Its
 * amount changes by date with POST .../amounts, never here.
 */
export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const before = await retainerInProject(supabase, params.id, params.retainerId);
  let saved;
  try {
    saved = await saveProjectRetainer(supabase, before.id, body as z.infer<typeof updateRetainerSchema>);
  } catch (error) {
    throw moneyRpcError(error as { code?: string; message: string }, 'Retainer');
  }
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${params.id}/retainers/${before.id}`,
    entityType: 'project_retainer',
    entityId: before.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: saved,
    statusCode: 200,
  });
  return success(saved);
}, { schema: updateRetainerSchema, permission: 'invoices.manage' });
