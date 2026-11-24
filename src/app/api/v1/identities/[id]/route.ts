import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { adminUnlinkIdentity } from '@/lib/api/identities';

/**
 * Unlinks anyone's account: the row goes, and the delegation tokens minted
 * for it with it. Answers { removed }.
 *
 * Permission: team.manage.
 */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await adminUnlinkIdentity(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/identities/${params.id}`, entityType: 'member_identity', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: result.removed, statusCode: 200 });
  return success(result);
}, { permission: 'team.manage' });
