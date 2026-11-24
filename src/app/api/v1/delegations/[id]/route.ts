import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { revokeDelegation } from '@/lib/api/delegation';

/** Revokes one of your agent's delegation tokens at once. Permission: agents.act_for. */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, apiKeyId }) => {
  const result = await revokeDelegation(supabase, teamMemberId, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/delegations/${params.id}`, entityType: 'delegation', entityId: params.id, apiKeyId, teamMemberId, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { permission: 'agents.act_for' });
