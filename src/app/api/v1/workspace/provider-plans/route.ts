import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { requireAgentsEnabled } from '@/lib/api/agents';

export const dynamic = 'force-dynamic';

const COLUMNS = 'id, provider, monthly_cost_usd, seats, notes, updated_at';

const providerPlanSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  monthly_cost_usd: z.number().min(0).max(1_000_000),
  seats: z.number().int().min(1).max(10_000).default(1),
  notes: z.string().trim().max(500).default(''),
}).strict();
type ProviderPlanBody = z.infer<typeof providerPlanSchema>;

/**
 * Settings > Workspace > AI provider plans: what a provider's subscription
 * costs a month, per seat. Agents > Analytics shows it beside measured
 * model cost as an estimate, never added to it. Any member but a guest
 * reads them; only an Owner saves, on a key that carries settings.manage.
 * With the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access }) => {
  requireAgentsEnabled(access);
  if (access.role === 'guest') throw forbidden('A guest does not see provider plans', { reason: 'guest' });
  const { data, error } = await supabase.from('provider_plans').select(COLUMNS).order('provider');
  if (error) throw error;
  return success(data ?? []);
}, { permission: 'tasks.read' });

/**
 * Saves a provider's plan: a provider already listed (matched without
 * regard to case) has its plan changed, as in Settings. Answers the plan.
 */
export const PUT = withApi<ProviderPlanBody>(async ({ supabase, access, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  assertOwnerCaller(access, 'changes provider plans');
  const { data: plans, error: readError } = await supabase.from('provider_plans').select(COLUMNS);
  if (readError) throw readError;
  const existing = ((plans ?? []) as { id: string; provider: string }[]).find((plan) => plan.provider.toLowerCase() === body.provider.toLowerCase()) ?? null;
  const fields = { ...body, updated_by: teamMemberId };
  const { data, error } = existing
    ? await supabase.from('provider_plans').update(fields).eq('id', existing.id).select(COLUMNS).single()
    : await supabase.from('provider_plans').insert(fields).select(COLUMNS).single();
  if (error) throw error;
  logAudit(supabase, { method: 'PUT', endpoint: '/api/v1/workspace/provider-plans', entityType: 'provider_plan', entityId: (data as { id: string }).id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: existing, afterSnapshot: data, statusCode: 200 });
  return success({ ...(data as object), created: !existing });
}, { schema: providerPlanSchema, permission: 'settings.manage' });
