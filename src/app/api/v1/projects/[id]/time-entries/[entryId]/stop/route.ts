import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');
  if (before.end_time) throw badRequest('Timer is not running');

  const { data, error } = await supabase
    .from('time_entries')
    .update({ end_time: new Date().toISOString() })
    .eq('id', entryId)
    .eq('project_id', id)
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${id}/time-entries/${entryId}/stop`,
    entityType: 'time_entry',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success(data);
});
