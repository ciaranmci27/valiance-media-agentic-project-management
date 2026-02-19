import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateCommentSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { commentId } = params as any;

  const { data, error } = await supabase
    .from('comments')
    .update(body)
    .eq('id', commentId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Comment');
  return success(data);
}, { schema: updateCommentSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { commentId } = params as any;

  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('id', commentId);

  if (error) throw error;
  return success({ deleted: true });
});
