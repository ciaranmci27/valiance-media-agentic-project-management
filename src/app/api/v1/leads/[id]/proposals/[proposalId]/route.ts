import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadProposalSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, proposalId } = params as any;
  const { data, error } = await supabase
    .from('lead_proposals')
    .select('*')
    .eq('id', proposalId)
    .eq('lead_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Proposal');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, proposalId } = params as any;
  const { data: before } = await supabase.from('lead_proposals').select('*').eq('id', proposalId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Proposal');

  const { data, error } = await supabase
    .from('lead_proposals')
    .update(body)
    .eq('id', proposalId)
    .eq('lead_id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Proposal');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/leads/${id}/proposals/${proposalId}`, entityType: 'lead_proposal', entityId: proposalId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateLeadProposalSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, proposalId } = params as any;
  const { data: before } = await supabase.from('lead_proposals').select('*').eq('id', proposalId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Proposal');

  const { error } = await supabase
    .from('lead_proposals')
    .delete()
    .eq('id', proposalId)
    .eq('lead_id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}/proposals/${proposalId}`, entityType: 'lead_proposal', entityId: proposalId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
