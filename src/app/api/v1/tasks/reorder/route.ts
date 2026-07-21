import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { forbidden, notFound } from '@/lib/api/errors';
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
    .select('id, project_id, status, sort_order, task_assignees(member_id)')
    .eq('id', task_id)
    .maybeSingle();

  if (!task) throw notFound('Task');
  if (!accessAllowsProject(access, task.project_id, 'api')) throw forbidden('Project scope denied');
  const canManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
  const assigned = (task.task_assignees || []).some((row: { member_id: string }) => row.member_id === teamMemberId);
  if (!canManageAll && !assigned) throw forbidden('This API key can only reorder assigned tasks');

  const oldOrder = task.sort_order;

  if (oldOrder === new_sort_order) {
    return success(task);
  }

  // Fetch all tasks in the same project+status group, reorder them
  const { data: siblings } = await supabase
    .from('tasks')
    .select('id, sort_order')
    .eq('project_id', task.project_id)
    .eq('status', task.status)
    .order('sort_order')
    .order('created_at');

  if (!siblings) return success(task);

  // Remove the moved task and insert at new position
  const filtered = siblings.filter(t => t.id !== task_id);
  const insertAt = Math.min(new_sort_order, filtered.length);
  filtered.splice(insertAt, 0, { id: task_id, sort_order: new_sort_order });

  // Reassign sequential sort_order values, only update changed rows
  const reordered = filtered.map((t, idx) => ({ id: t.id, sort_order: idx }));
  for (const u of reordered) {
    if (siblings.find(s => s.id === u.id)?.sort_order !== u.sort_order) {
      const { error: updateErr } = await supabase
        .from('tasks')
        .update({ sort_order: u.sort_order })
        .eq('id', u.id);
      if (updateErr) console.error(`[reorder] Failed to update task ${u.id}:`, updateErr);
    }
  }

  const finalOrder = reordered.find(u => u.id === task_id)?.sort_order ?? insertAt;

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
