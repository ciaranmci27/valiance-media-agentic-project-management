import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moneyRpcError } from '@/lib/api/money-api';
import { fetchBillingPlan, saveBillingPlan } from '@/lib/supabase/queries';
import { calendarDate } from '@/lib/schemas/shared';

export const dynamic = 'force-dynamic';

const PLAN_FIELDS = [
  'payment_terms_days', 'hours_trigger', 'days_of_month', 'every_weeks', 'weeks_anchor', 'trigger_amount',
  'cap_mode', 'cap_value', 'min_amount', 'combine_with_retainer', 'paused', 'starts_on', 'ends_on',
] as const;

const updatePlanSchema = z.object({
  payment_terms_days: z.number().int().min(0).max(120).optional(),
  hours_trigger: z.enum(['manual', 'days_of_month', 'every_weeks', 'reaches_amount', 'fixed_blocks']).optional(),
  days_of_month: z.array(z.number().int().min(1).max(31)).min(1).max(4).optional(),
  every_weeks: z.number().int().min(1).max(12).optional(),
  weeks_anchor: calendarDate.nullable().optional(),
  trigger_amount: z.number().positive().nullable().optional(),
  cap_mode: z.enum(['none', 'amount', 'hours']).optional(),
  cap_value: z.number().positive().nullable().optional(),
  min_amount: z.number().min(0).optional(),
  combine_with_retainer: z.boolean().optional(),
  paused: z.boolean().optional(),
  starts_on: calendarDate.nullable().optional(),
  ends_on: calendarDate.nullable().optional(),
}).strict().refine((value) => PLAN_FIELDS.some((field) => value[field] !== undefined), {
  message: `Send at least one of: ${PLAN_FIELDS.join(', ')}`,
});

/** The project's billing plan (payment terms, when hours are drafted), or the defaults when none is saved. */
export const GET = withApi(async ({ supabase, params }) => {
  return success(await fetchBillingPlan(supabase, params.id));
}, { permission: 'invoices.read' });

/**
 * Changes the billing plan (Billing > Hours): only the fields sent change.
 * Switching to a new hours_trigger without starts_on starts it today, so
 * turning drafting on never drafts dates that already passed.
 */
export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const before = await fetchBillingPlan(supabase, params.id);
  let saved;
  try {
    saved = await saveBillingPlan(supabase, params.id, body as z.infer<typeof updatePlanSchema>);
  } catch (error) {
    throw moneyRpcError(error as { code?: string; message: string }, 'Project');
  }
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${params.id}/billing-plan`,
    entityType: 'project_billing_plan',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: saved,
    statusCode: 200,
  });
  return success(saved);
}, { schema: updatePlanSchema, permission: 'invoices.manage' });
