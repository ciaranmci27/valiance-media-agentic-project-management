import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createCommentSchema } from '@/lib/schemas';
import { insertComment } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('task_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const { user_id, text } = body as any;
  const comment = await insertComment(supabase, id, user_id, text);
  return created(comment);
}, { schema: createCommentSchema });
