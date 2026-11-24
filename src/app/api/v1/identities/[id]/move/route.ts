import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { adminMoveIdentity } from '@/lib/api/identities';
import { moveIdentitySchema, type MoveIdentityInput } from '@/lib/identities';

/**
 * Moves an account to another member: unlinked (its tokens go with it),
 * then linked to member_id, verified as admin. Answers { removed, linked }.
 *
 * Permission: team.manage.
 */
export const POST = withApi<MoveIdentityInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await adminMoveIdentity(supabase, { memberId: teamMemberId, access, scopes }, params.id, body.member_id);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/identities/${params.id}/move`, entityType: 'member_identity', entityId: result.linked.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: result.removed, afterSnapshot: result.linked, statusCode: 200 });
  return success(result);
}, { schema: moveIdentitySchema, permission: 'team.manage' });
