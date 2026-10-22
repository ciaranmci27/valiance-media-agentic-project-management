import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { count, error: countError } = await supabase
    .from('project_hourly_rates')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', params.id)
    .is('deleted_at', null);
  if (countError) throw countError;
  if ((count || 0) <= 1) throw badRequest('Keep at least one rate in the project schedule');

  const { data: before, error: fetchError } = await supabase
    .from('project_hourly_rates')
    .select('*')
    .eq('id', params.rateId)
    .eq('project_id', params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!before) throw notFound('Hourly rate');

  await trashForApi(supabase, 'project_hourly_rates', params.rateId, teamMemberId, 'Hourly rate');

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${params.id}/hourly-rates/${params.rateId}`,
    entityType: 'project_hourly_rate',
    entityId: params.rateId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });
  return success({ deleted: true });
}, { permission: 'billing.manage' });
