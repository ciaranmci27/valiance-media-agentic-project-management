import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchTask } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      *,
      task_assignees(member_id),
      subtasks(id, task_id, title, completed, sort_order),
      comments(id, task_id, user_id, text, created_at)
    `)
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Task');

  const task = {
    ...data,
    assignee_ids: (data.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (data.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (data.comments || []).sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    task_assignees: undefined,
  };

  return success(task);
});

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { assignee_ids, ...updates } = body as any;
  const data = await patchTask(supabase, (params as any).id, updates, assignee_ids);
  return success(data);
}, { schema: updateTaskSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', (params as any).id);

  if (error) throw error;
  return success({ deleted: true });
});
