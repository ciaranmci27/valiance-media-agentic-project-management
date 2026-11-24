import { withApi } from '@/lib/api/middleware';
import { paginated, success } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { addGroupMembers, groupMemberFiltersFrom, listGroupMembers } from '@/lib/api/groups';
import { addGroupMembersSchema, type AddGroupMembersInput } from '@/lib/groups';

/**
 * A group's members, leads first, paged. Filters: search (name), role
 * (member or lead). Each with member_id, name, team_role, status and role.
 *
 * Permission: team.read (or team.manage); a member reads the groups they are in.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listGroupMembers(supabase, { memberId: teamMemberId, access, scopes }, params.id, { ...groupMemberFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['team.read', 'groups.manage'] });

/**
 * Adds members (member_ids, up to 500) with role member (default) or lead;
 * one already in it takes the role sent. Answers { added, updated }.
 *
 * Permission: groups.manage.
 */
export const POST = withApi<AddGroupMembersInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await addGroupMembers(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/groups/${params.id}/members`, entityType: 'group', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { schema: addGroupMembersSchema, permission: 'groups.manage' });
