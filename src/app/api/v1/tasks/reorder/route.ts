import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';

const reorderSchema = z.object({
  task_id: z.string().uuid(),
  new_sort_order: z.number().int().min(0),
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { task_id, new_sort_order } = body as z.infer<typeof reorderSchema>;

  // Fetch the task to get project_id and status
  const { data: task } = await supabase
    .from('tasks')
    .select('id, project_id, parent_task_id, status, sort_order, task_assignees(member_id)')
    .eq('id', task_id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!task) throw notFound('Task');
  // A task in a project in Trash reads as missing too.
  const { data: liveProject } = await supabase
    .from('projects')
    .select('id')
    .eq('id', task.project_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!liveProject) throw notFound('Task');
  if (!accessAllowsProject(access, task.project_id, 'api')) throw forbidden('Project scope denied');
  const canManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
  const assigned = (task.task_assignees || []).some((row: { member_id: string }) => row.member_id === teamMemberId);
  if (!canManageAll && !assigned) throw forbidden('This API key can only reorder assigned tasks');

  const oldOrder = task.sort_order;

  if (oldOrder === new_sort_order) {
    return success(task);
  }

  // Siblings (a subtask's: its parent's other subtasks; a top-level task's:
  // the top-level tasks in its project and status column) are renumbered in
  // one transaction, one move at a time per list, so moves sent together
  // never leave two tasks on one position (pm.move_task_to_position).
  const { data: moved, error: moveError } = await supabase.rpc('move_task_to_position', { p_task_id: task_id, p_position: new_sort_order });
  if (moveError) {
    if (moveError.code === 'PGRST202' || /move_task_to_position/.test(moveError.message ?? '') && /schema cache|does not exist|could not find/i.test(moveError.message ?? '')) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Reordering needs the database update 20261127001400_lifecycle_fixes.sql. Apply it (npm run db:migrate), then try again.', { reason: 'migration_pending' });
    }
    throw moveError;
  }
  if (moved === null) throw notFound('Task');
  const finalOrder = moved as number;

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/tasks/reorder',
    entityType: 'task',
    entityId: task_id,
    apiKeyId,
    teamMemberId,
    requestBody: { task_id, new_sort_order },
    beforeSnapshot: { sort_order: oldOrder },
    afterSnapshot: { sort_order: finalOrder },
    statusCode: 200,
  });

  return success({ task_id, sort_order: finalOrder });
}, { schema: reorderSchema, permission: 'tasks.manage_all' });
