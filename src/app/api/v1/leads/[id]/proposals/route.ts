import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createLeadProposalSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertLeadProposal } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');

  let query = supabase
    .from('lead_proposals')
    .select('*', { count: 'exact' })
    .eq('lead_id', id);

  if (status) query = query.eq('status', status);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: lead } = await supabase.from('leads').select('id').eq('id', id).maybeSingle();
  if (!lead) throw notFound('Lead');

  const proposal = await insertLeadProposal(supabase, { ...body as any, lead_id: id });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/proposals`, entityType: 'lead_proposal', entityId: proposal.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: proposal, statusCode: 201 });
  return created(proposal);
}, { schema: createLeadProposalSchema });
