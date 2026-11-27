import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { notFound } from '@/lib/api/errors';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { requireAgentsEnabled } from '@/lib/api/agents';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Removes a provider's plan; Analytics stops estimating its subscription. Owner only, on a key that carries settings.manage. */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, access, params, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  assertOwnerCaller(access, 'changes provider plans');
  if (!UUID.test(params.id)) throw notFound('Provider plan');
  const { data, error } = await supabase.from('provider_plans').delete().eq('id', params.id).select('id, provider, monthly_cost_usd, seats, notes').maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Provider plan');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/workspace/provider-plans/${params.id}`, entityType: 'provider_plan', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: data, statusCode: 200 });
  return success({ id: params.id, removed: true });
}, { permission: 'settings.manage' });
