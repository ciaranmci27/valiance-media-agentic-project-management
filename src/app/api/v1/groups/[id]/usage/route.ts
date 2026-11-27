import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { groupUsage } from '@/lib/api/groups';

export const dynamic = 'force-dynamic';

/**
 * What a group controls ("Used for" on its page): the agents it owns and
 * that escalate to it, the inboxes it handles, is the default for or decides
 * for, the initiatives it owns and the assistant setups that match it. Each
 * as { total, names } (a few names). For whoever reads the group, as
 * GET /api/v1/groups/{id}. Permission: team.read (or groups.manage).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await groupUsage(supabase, { memberId: teamMemberId, access, scopes }, params.id)), { permission: ['team.read', 'groups.manage'] });
