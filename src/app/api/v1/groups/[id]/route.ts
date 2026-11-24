import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { getGroup, trashGroup, updateGroup } from '@/lib/api/groups';
import { updateGroupSchema, type UpdateGroupInput } from '@/lib/groups';

/** One group. Permission: team.read (or team.manage); a member reads the groups they are in. */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getGroup(supabase, { memberId: teamMemberId, access, scopes }, params.id)), { permission: ['team.read', 'groups.manage'] });

/** Changes a group's name, slug, description or external_id. Permission: groups.manage. */
export const PATCH = withApi<UpdateGroupInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { before, group } = await updateGroup(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/groups/${params.id}`, entityType: 'group', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: group, statusCode: 200 });
  return success(group);
}, { schema: updateGroupSchema, permission: 'groups.manage' });

/**
 * Moves a group to Trash: it stops being a target for new questions,
 * escalation and ownership; who was in it is kept. Permission: groups.manage.
 */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const group = await trashGroup(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/groups/${params.id}`, entityType: 'group', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: group, statusCode: 200 });
  return success({ id: params.id, deleted: true });
}, { permission: 'groups.manage' });
