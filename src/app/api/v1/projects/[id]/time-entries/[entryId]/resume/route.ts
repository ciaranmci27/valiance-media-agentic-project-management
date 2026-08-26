import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { isStalePause } from '@/lib/time-entry-utils';
import type { TimeSegment } from '@/lib/types';
import { apiKeyAllows, sanitizeTimeEntryForAccess } from '@/lib/api/access';

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access, scopes }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('project_time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');
  if (!apiKeyAllows(access, scopes, 'time.manage_all') && before.member_id !== teamMemberId) {
    throw notFound('Time entry');
  }
  if (before.end_time) throw badRequest('Timer is already finalized');

  const segments: TimeSegment[] = Array.isArray(before.segments) ? before.segments : [];
  const last = segments[segments.length - 1];
  if (!last || last.end === null) {
    throw badRequest('Timer is not paused');
  }

  // Stale guard: a pause that crossed a calendar day in the member's
  // timezone AND is at least MIN_STALE_PAUSE_MS old auto-finalizes instead
  // of resuming. The age floor matters because timezone defaults to 'UTC',
  // whose midnight lands mid-evening for members west of it; without the
  // floor a fresh pause straddling that instant was finalized on resume.
  const { data: member } = await supabase
    .from('team_members')
    .select('timezone')
    .eq('id', before.member_id)
    .maybeSingle();
  const tz = member?.timezone || undefined;
  if (isStalePause(last.end, tz)) {
    const { data: finalized, error: finalizeErr } = await supabase
      .from('project_time_entries')
      .update({ end_time: last.end })
      .eq('id', entryId)
      .eq('project_id', id)
      .select()
      .single();
    if (finalizeErr) throw finalizeErr;

    logAudit(supabase, {
      method: 'POST',
      endpoint: `/api/v1/projects/${id}/time-entries/${entryId}/resume`,
      entityType: 'time_entry',
      entityId: entryId,
      apiKeyId,
      teamMemberId,
      beforeSnapshot: before,
      afterSnapshot: finalized,
      statusCode: 200,
    });
    return success(sanitizeTimeEntryForAccess(finalized, access, 'api'));
  }

  const resumedAt = new Date().toISOString();
  const newSegments = [...segments, { start: resumedAt, end: null }];

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
    endpoint: `/api/v1/projects/${id}/time-entries/${entryId}/resume`,
    entityType: 'time_entry',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: data,
    statusCode: 200,
  });

  return success(sanitizeTimeEntryForAccess(data, access, 'api'));
}, { permission: ['time.manage_own', 'time.manage_all'] });
