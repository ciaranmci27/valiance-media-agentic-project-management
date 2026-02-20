import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createLeadProposalSchema } from '@/lib/schemas';
import { insertLeadProposal } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

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

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const proposal = await insertLeadProposal(supabase, { ...body as any, lead_id: id });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/proposals`, entityType: 'lead_proposal', entityId: proposal.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: proposal, statusCode: 201 });
  return created(proposal);
}, { schema: createLeadProposalSchema });
