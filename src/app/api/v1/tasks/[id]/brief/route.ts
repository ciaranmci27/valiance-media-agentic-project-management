import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { buildTaskBrief } from '@/lib/api/task-brief';

export const dynamic = 'force-dynamic';

/**
 * Everything an agent needs to work one task, in one call: the task with its
 * criteria, subtasks and blockers, its project and context entries, the
 * newest comments, files and links, the open question, the claim and the
 * caller's rules. Same access as GET /api/v1/tasks/{id} (tasks.read and the
 * task's project); parts the key cannot read are listed in omitted.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  return success(await buildTaskBrief({ supabase, access, scopes, teamMemberId }, params.id));
}, { permission: 'tasks.read' });
