import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { removeLeadField } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, fieldId } = params as any;
  const { data, error } = await supabase
    .from('lead_fields')
    .select('*')
    .eq('id', fieldId)
    .eq('lead_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead field');
  return success(data);
});

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, fieldId } = params as any;
  const { data: before } = await supabase.from('lead_fields').select('*').eq('id', fieldId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Lead field');
  await removeLeadField(supabase, fieldId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}/fields/${fieldId}`, entityType: 'lead_field', entityId: fieldId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
