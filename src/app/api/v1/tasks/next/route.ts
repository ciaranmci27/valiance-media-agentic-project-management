import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { nextTask } from '@/lib/api/claims';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The best task for the key's member to work on next, or null: tasks
 * assigned to them first, then unassigned work they may pick up. It does not
 * claim it: claim it with POST /api/v1/tasks/:id/claim.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const projectId = searchParams.get('project_id');
  if (projectId && !UUID.test(projectId)) throw badRequest('project_id must be a uuid');
  return success(await nextTask({ supabase, memberId: teamMemberId, access, scopes }, projectId));
}, { permission: 'tasks.read' });
