import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadInteractionSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { interactionId } = params as any;

  const { data, error } = await supabase
    .from('lead_interactions')
    .update(body)
    .eq('id', interactionId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Interaction');
  return success(data);
}, { schema: updateLeadInteractionSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { interactionId } = params as any;

  const { error } = await supabase
    .from('lead_interactions')
    .delete()
    .eq('id', interactionId);

  if (error) throw error;
  return success({ deleted: true });
});
