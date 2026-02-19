import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { reorderSubtasksSchema } from '@/lib/schemas';
import { reorderSubtasks } from '@/lib/supabase/queries';
import { badRequest } from '@/lib/api/errors';

export const PUT = withApi(async ({ supabase, params, body }) => {
  const { id: taskId } = params as any;
  const { subtask_ids } = body as any;

  // Verify all subtask_ids belong to this task
  const { data: existing } = await supabase
    .from('subtasks')
    .select('id')
    .eq('task_id', taskId)
    .in('id', subtask_ids);

  if (!existing || existing.length !== subtask_ids.length) {
    throw badRequest('One or more subtask IDs do not belong to this task');
  }

  await reorderSubtasks(supabase, subtask_ids);
  return success({ reordered: true });
}, { schema: reorderSubtasksSchema });
