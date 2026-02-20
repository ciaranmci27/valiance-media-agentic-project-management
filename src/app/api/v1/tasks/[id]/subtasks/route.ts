import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertSubtask } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('subtasks')
    .select('*')
    .eq('task_id', id)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const subtask = await insertSubtask(supabase, id, (body as any).title);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/subtasks`, entityType: 'subtask', entityId: subtask.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: subtask, statusCode: 201 });
  return created(subtask);
}, { schema: createSubtaskSchema });
