import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadInteractionSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, interactionId } = params as any;
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .eq('id', interactionId)
    .eq('lead_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Interaction');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, interactionId } = params as any;
  const { data: before } = await supabase.from('lead_interactions').select('*').eq('id', interactionId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Interaction');

  const { data, error } = await supabase
    .from('lead_interactions')
    .update(body)
    .eq('id', interactionId)
    .eq('lead_id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Interaction');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/leads/${id}/interactions/${interactionId}`, entityType: 'lead_interaction', entityId: interactionId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateLeadInteractionSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, interactionId } = params as any;
  const { data: before } = await supabase.from('lead_interactions').select('*').eq('id', interactionId).eq('lead_id', id).maybeSingle();
  if (!before) throw notFound('Interaction');

  const { error } = await supabase
    .from('lead_interactions')
    .delete()
    .eq('id', interactionId)
    .eq('lead_id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}/interactions/${interactionId}`, entityType: 'lead_interaction', entityId: interactionId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
