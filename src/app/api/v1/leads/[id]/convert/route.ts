import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { convertLeadSchema } from '@/lib/schemas';
import { notFound, conflict } from '@/lib/api/errors';
import { convertLead } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const { project_name, project_color, project_description } = body as any;

  // Fetch the lead with members
  const { data: leadData, error: leadError } = await supabase
    .from('leads')
    .select('*, lead_members(member_id)')
    .eq('id', id)
    .maybeSingle();

  if (leadError) throw leadError;
  if (!leadData) throw notFound('Lead');
  if (leadData.status === 'won') throw conflict('Lead has already been converted');

  const lead = {
    ...leadData,
    member_ids: (leadData.lead_members || []).map((lm: any) => lm.member_id),
    lead_members: undefined,
  };

  let result;
  try {
    result = await convertLead(
      supabase,
      lead,
      project_name,
      project_color,
      project_description,
      null
    );
  } catch (err: any) {
    // The convert_lead RPC raises LC409 when it loses a conversion race to a
    // concurrent request; surface that as a conflict, not a server error
    if (err?.code === 'LC409' || /already been converted/i.test(err?.message || '')) {
      throw conflict('Lead has already been converted');
    }
    throw err;
  }

  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/convert`, entityType: 'lead', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: lead, afterSnapshot: result, statusCode: 200 });

  return success({
    lead: result.lead,
    project: result.project,
    contact: result.contact,
    project_contact: result.projectContact,
  });
}, { schema: convertLeadSchema });
