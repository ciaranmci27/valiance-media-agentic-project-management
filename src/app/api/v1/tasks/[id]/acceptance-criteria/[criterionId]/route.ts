import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateAcceptanceCriterionSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, criterionId } = params as any;
  const { data: before } = await supabase.from('task_acceptance_criteria').select('*').eq('id', criterionId).eq('task_id', id).maybeSingle();
  if (!before) throw notFound('Acceptance criterion');

  const { data, error } = await supabase
    .from('task_acceptance_criteria')
    .update(body)
    .eq('id', criterionId)
    .eq('task_id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Acceptance criterion');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/tasks/${id}/acceptance-criteria/${criterionId}`, entityType: 'acceptance_criterion', entityId: criterionId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateAcceptanceCriterionSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, criterionId } = params as any;
  const { data: before } = await supabase.from('task_acceptance_criteria').select('*').eq('id', criterionId).eq('task_id', id).maybeSingle();
  if (!before) throw notFound('Acceptance criterion');

  const { error } = await supabase
    .from('task_acceptance_criteria')
    .delete()
    .eq('id', criterionId)
    .eq('task_id', id);

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/acceptance-criteria/${criterionId}`, entityType: 'acceptance_criterion', entityId: criterionId, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
