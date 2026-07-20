import { after } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTimeEntrySchema } from '@/lib/schemas';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { evaluateBudgetAlerts } from '@/lib/email/client-notifications';
import type { TimeSegment } from '@/lib/types';
import { resolveProjectHourlyRate } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id, entryId } = params as any;

  const { data, error } = await supabase
    .from('project_time_entries')
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
    .from('project_time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');

  // Canonicalize segments when the denormalized range of a finalized entry
  // is being updated. Rule: for a finalized entry (end_time not null before
  // and after the patch), if the caller updates start_time or end_time
  // without supplying an explicit `segments` array, collapse to a single
  // [start, end] segment — same behavior as the UI's main-row editor, which
  // is the expected outcome since there is no automatic way to preserve
  // multi-segment pause history while rewriting the outer bounds.
  //
  // For unfinalized entries (running or paused), auto-deriving segments is
  // unsafe: collapsing could silently transition a paused timer to running
  // or vice versa. Require the caller to send segments explicitly in that
  // case so the state machine stays their responsibility.
  const patch: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const hasStartUpdate = 'start_time' in patch;
  const hasEndUpdate = 'end_time' in patch;
  const hasSegmentsUpdate = 'segments' in patch;

  if ((hasStartUpdate || hasEndUpdate) && !hasSegmentsUpdate) {
    const nextStart = (hasStartUpdate ? patch.start_time : before.start_time) as string | null;
    const nextEnd = (hasEndUpdate ? patch.end_time : before.end_time) as string | null;
    if (!nextStart) throw badRequest('start_time cannot be cleared');
    if (before.end_time === null || nextEnd === null) {
      throw badRequest(
        'Updating start_time or end_time on an unfinalized entry requires an explicit segments array',
      );
    }
    const nextSegments: TimeSegment[] = [{ start: nextStart, end: nextEnd }];
    patch.segments = nextSegments;
  }

  if (hasStartUpdate) {
    patch.hourly_rate = await resolveProjectHourlyRate(supabase, id, patch.start_time as string);
  }

  const { data, error } = await supabase
    .from('project_time_entries')
    .update(patch as any)
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

  // Use after() so the promise reliably resolves on serverless
  // platforms; a bare .catch() can be killed when the response sends.
  after(() => evaluateBudgetAlerts(id));

  return success(data);
}, { schema: updateTimeEntrySchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('project_time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');

  const { error } = await supabase
    .from('project_time_entries')
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
