import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSubtaskSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { subtaskId } = params as any;

  const { data, error } = await supabase
    .from('subtasks')
    .update(body)
    .eq('id', subtaskId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Subtask');
  return success(data);
}, { schema: updateSubtaskSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { subtaskId } = params as any;

  const { error } = await supabase
    .from('subtasks')
    .delete()
    .eq('id', subtaskId);

  if (error) throw error;
  return success({ deleted: true });
});
