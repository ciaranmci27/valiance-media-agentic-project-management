import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import type { TimeSegment } from '@/lib/types';

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('project_time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');
  if (before.end_time) throw badRequest('Timer is not running');

  const segments: TimeSegment[] = Array.isArray(before.segments) ? before.segments : [];
  const last = segments[segments.length - 1];
  if (!last || last.end !== null) {
    throw badRequest('Timer is already paused');
  }

  const pausedAt = new Date().toISOString();
  const newSegments = [...segments.slice(0, -1), { ...last, end: pausedAt }];

  const { data, error } = await supabase
    .from('project_time_entries')
    .update({ segments: newSegments })
    .eq('id', entryId)
    .eq('project_id', id)
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${id}/time-entries/${entryId}/pause`,
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
