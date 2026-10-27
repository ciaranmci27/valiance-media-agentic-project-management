import type { SupabaseClient } from '@supabase/supabase-js';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';
import { patchTask } from '@/lib/supabase/queries';

// Kept for callers of the old text subtasks (see ../route.ts): title and
// completed map onto the subtask task's title and status.

async function subtaskOf(supabase: SupabaseClient, parentId: string, subtaskId: string) {
  const { data } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', subtaskId)
    .eq('parent_task_id', parentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data) throw notFound('Subtask');
  return data as { id: string; title: string; status: string; sort_order: number };
}

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as { id: string; subtaskId: string };
  const before = await subtaskOf(supabase, id, subtaskId);
  const { title, completed } = body as { title?: string; completed?: boolean };
  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  // Reopening puts it back in To Do; checking it off is done.
  if (completed === true && before.status !== 'done') updates.status = 'done';
  if (completed === false && before.status === 'done') updates.status = 'todo';
  const row = Object.keys(updates).length > 0 ? await patchTask(supabase, subtaskId, updates) : before;
  const data = { id: row.id, task_id: id, title: row.title, status: row.status, completed: row.status === 'done', sort_order: row.sort_order };
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'task', entityId: subtaskId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateSubtaskSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, subtaskId } = params as { id: string; subtaskId: string };
  const before = await subtaskOf(supabase, id, subtaskId);
  await trashForApi(supabase, 'tasks', subtaskId, teamMemberId, 'Subtask');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/subtasks/${subtaskId}`, entityType: 'task', entityId: subtaskId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
