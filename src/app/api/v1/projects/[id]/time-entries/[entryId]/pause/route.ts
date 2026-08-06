import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import type { TimeSegment } from '@/lib/types';
import { apiKeyAllows, sanitizeTimeEntryForAccess } from '@/lib/api/access';

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
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
  if (before.end_time) throw badRequest('Timer is not running');

  const segments: TimeSegment[] = Array.isArray(before.segments) ? before.segments : [];
  const last = segments[segments.length - 1];
  if (!last || last.end !== null) {
    throw badRequest('Timer is already paused');
  }

  // Optional retroactive pause, SHORTEN-ONLY. Exists for cut-off recovery:
  // when an agent's turn dies mid-build with the timer running, the dead gap
  // until recovery would otherwise be billed inside one continuous segment.
  // Recovery passes the last real action's timestamp (from the runtime's own
  // tool log / workspace mtimes) and the gap becomes a recorded pause.
  //
  // The bounds make the abusable direction impossible: worked_until must lie
  // INSIDE the open segment, so a segment can only ever be trimmed, never
  // extended, and never into a previous segment. Billing can only go down.
  const requestedRaw = (body as Record<string, unknown> | undefined)?.worked_until;
  let pausedAt = new Date().toISOString();
  if (typeof requestedRaw === 'string' && requestedRaw.trim()) {
    const requested = new Date(requestedRaw);
    if (Number.isNaN(requested.getTime())) throw badRequest('worked_until is not a valid timestamp');
    const segStart = new Date(last.start);
    const now = new Date();
    if (requested.getTime() <= segStart.getTime() || requested.getTime() > now.getTime()) {
      throw badRequest('worked_until must fall inside the currently running segment');
    }
    pausedAt = requested.toISOString();
  }
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

  return success(sanitizeTimeEntryForAccess(data, access, 'api'));
}, { permission: ['time.manage_own', 'time.manage_all'] });
