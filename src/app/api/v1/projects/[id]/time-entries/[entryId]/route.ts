import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTimeEntrySchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, entryId } = params as any;

  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Time entry');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');

  const { data, error } = await supabase
    .from('time_entries')
    .update(body as any)
    .eq('id', entryId)
    .eq('project_id', id)
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${id}/time-entries/${entryId}`,
    entityType: 'time_entry',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success(data);
}, { schema: updateTimeEntrySchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');

  const { error } = await supabase
    .from('time_entries')
    .delete()
    .eq('id', entryId)
    .eq('project_id', id);

  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${id}/time-entries/${entryId}`,
    entityType: 'time_entry',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });

  return success({ deleted: true });
});
