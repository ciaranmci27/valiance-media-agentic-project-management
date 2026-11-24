import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { createGroup, groupFiltersFrom, listGroups } from '@/lib/api/groups';
import { createGroupSchema, type CreateGroupInput } from '@/lib/groups';

/**
 * The groups the key's member may read, by name, paged: every live group for
 * a member who may read the team, else the ones they are in. Filters: search
 * (name or slug), member (me or a member id). Each with member_count,
 * lead_count and is_member.
 *
 * Permission: team.read (or team.manage).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listGroups(supabase, { memberId: teamMemberId, access, scopes }, { ...groupFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: 'team.read' });

/**
 * Creates a group: name, slug (made from the name when left out),
 * description, external_id (a directory's id), member_ids and lead_ids (up
 * to 500). 409 slug_taken or external_id_taken.
 *
 * Permission: groups.manage.
 */
export const POST = withApi<CreateGroupInput>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const group = await createGroup(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/groups', entityType: 'group', entityId: group.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: group, statusCode: 201 });
  return created(group);
}, { schema: createGroupSchema, permission: 'groups.manage' });
