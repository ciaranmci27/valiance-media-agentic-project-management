import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchLead } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*, lead_members(member_id)')
    .eq('id', (params as any).id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead');

  const lead = {
    ...data,
    member_ids: (data.lead_members || []).map((lm: any) => lm.member_id),
    lead_members: undefined,
  };

  return success(lead);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('leads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Lead');
  const { member_ids, ...updates } = body as any;
  const lead = await patchLead(supabase, id, updates, member_ids);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/leads/${id}`, entityType: 'lead', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: lead, statusCode: 200 });
  return success(lead);
}, { schema: updateLeadSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('leads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Lead');
  // Moves the lead to Trash; archiving is its own action (POST /leads/:id/archive).
  await trashForApi(supabase, 'leads', id, teamMemberId, 'Lead');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}`, entityType: 'lead', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
