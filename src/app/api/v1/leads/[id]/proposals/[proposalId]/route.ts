import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadProposalSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { proposalId } = params as any;

  const { data, error } = await supabase
    .from('lead_proposals')
    .update(body)
    .eq('id', proposalId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Proposal');
  return success(data);
}, { schema: updateLeadProposalSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { proposalId } = params as any;

  const { error } = await supabase
    .from('lead_proposals')
    .delete()
    .eq('id', proposalId);

  if (error) throw error;
  return success({ deleted: true });
});
