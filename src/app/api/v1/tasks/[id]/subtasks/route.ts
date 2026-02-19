import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertSubtask } from '@/lib/supabase/queries';

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

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const subtask = await insertSubtask(supabase, id, (body as any).title);
  return created(subtask);
}, { schema: createSubtaskSchema });
