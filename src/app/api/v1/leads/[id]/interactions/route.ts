import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createLeadInteractionSchema } from '@/lib/schemas';
import { insertLeadInteraction } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const type = searchParams.get('type');
  const completed = searchParams.get('completed');

  let query = supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', id);

  if (type) query = query.eq('type', type);
  if (completed !== null && completed !== undefined) {
    query = query.eq('completed', completed === 'true');
  }

  const { data, error } = await query.order('occurred_at', { ascending: false });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const interaction = await insertLeadInteraction(supabase, { ...body as any, lead_id: id });
  return created(interaction);
}, { schema: createLeadInteractionSchema });
