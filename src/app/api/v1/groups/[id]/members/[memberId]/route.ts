import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { removeGroupMember, setGroupMemberRole } from '@/lib/api/groups';
import { updateGroupMemberSchema } from '@/lib/groups';
import type { GroupRole } from '@/lib/groups';

type Params = { id: string; memberId: string };

/** Makes a member a lead, or a plain member again. Permission: groups.manage. */
export const PATCH = withApi<{ role: GroupRole }, Params>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await setGroupMemberRole(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.memberId, body.role);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/groups/${params.id}/members/${params.memberId}`, entityType: 'group', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { schema: updateGroupMemberSchema, permission: 'groups.manage' });

/** Takes a member out of the group. Permission: groups.manage. */
export const DELETE = withApi<unknown, Params>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await removeGroupMember(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.memberId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/groups/${params.id}/members/${params.memberId}`, entityType: 'group', entityId: params.id, apiKeyId, teamMemberId, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { permission: 'groups.manage' });
