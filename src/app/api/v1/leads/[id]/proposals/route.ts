import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createLeadProposalSchema } from '@/lib/schemas';
import { insertLeadProposal } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const status = searchParams.get('status');

  let query = supabase
    .from('lead_proposals')
    .select('*')
    .eq('lead_id', id);

  if (status) query = query.eq('status', status);

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const proposal = await insertLeadProposal(supabase, { ...body as any, lead_id: id });
  return created(proposal);
}, { schema: createLeadProposalSchema });
