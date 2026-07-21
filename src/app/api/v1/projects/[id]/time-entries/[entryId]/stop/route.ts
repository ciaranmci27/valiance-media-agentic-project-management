import { after } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { evaluateBudgetAlerts } from '@/lib/email/client-notifications';
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

  // Close any open segment before finalizing so segments stays consistent.
  const segments: TimeSegment[] = Array.isArray(before.segments) ? before.segments : [];
  const last = segments[segments.length - 1];
  const nowIso = new Date().toISOString();
  let newSegments = segments;
  if (last && last.end === null) {
    newSegments = [...segments.slice(0, -1), { ...last, end: nowIso }];
  }
  // end_time mirrors the last segment's end (nowIso we just set, or the
  // already-present pause timestamp if stopping from a paused state).
  const finalEnd = newSegments[newSegments.length - 1]?.end ?? nowIso;

  const { data, error } = await supabase
    .from('project_time_entries')
    .update({ end_time: finalEnd, segments: newSegments })
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

  // Use after() so the promise reliably resolves on serverless
  // platforms; a bare .catch() can be killed when the response sends.
  after(() => evaluateBudgetAlerts(id));

  return success(sanitizeTimeEntryForAccess(data, access, 'api'));
}, { permission: ['time.manage_own', 'time.manage_all'] });
