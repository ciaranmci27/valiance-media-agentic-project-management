import { after } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTimeEntrySchema } from '@/lib/schemas';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { evaluateBudgetAlerts } from '@/lib/email/client-notifications';
import type { TimeSegment } from '@/lib/types';
import { resolveProjectHourlyRate, TIME_ENTRY_SELECT, mapTimeEntryRow } from '@/lib/supabase/queries';
import { assertTasksInProject } from '@/lib/api/task-guards';
import { apiKeyAllows, sanitizeTimeEntryForAccess } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, params, access, teamMemberId, scopes }) => {
  const { id, entryId } = params as any;

  const { data, error } = await supabase
    .from('project_time_entries')
    .select(TIME_ENTRY_SELECT)
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Time entry');
  if (!apiKeyAllows(access, scopes, 'time.read_all') && (data as any).member_id !== teamMemberId) {
    throw notFound('Time entry');
  }
  return success(sanitizeTimeEntryForAccess(mapTimeEntryRow(data) as unknown as Record<string, unknown>, access, 'api'));
}, { permission: ['time.manage_own', 'time.read_all', 'time.manage_all'] });

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id, entryId } = params as any;

  const { data: before } = await supabase
    .from('project_time_entries')
    .select('*')
    .eq('id', entryId)
    .eq('project_id', id)
    .maybeSingle();

  if (!before) throw notFound('Time entry');
  const canManageAll = apiKeyAllows(access, scopes, 'time.manage_all');
  if (!canManageAll && before.member_id !== teamMemberId) {
    throw notFound('Time entry');
  }
  if (!canManageAll && before.approval_status === 'approved') {
    throw badRequest('Approved time cannot be edited');
  }

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
  if (!canManageAll) delete patch.member_id;
  if (canManageAll && typeof patch.member_id === 'string') {
    const { data: targetMember } = await supabase.from('team_members').select('id, status').eq('id', patch.member_id).maybeSingle();
    if (!targetMember || targetMember.status !== 'active') throw badRequest('Active team member not found');
    if (patch.member_id !== teamMemberId) {
      const { data: assignment } = await supabase.from('project_members').select('project_id').eq('project_id', id).eq('member_id', patch.member_id).maybeSingle();
      if (!assignment) throw badRequest('Team member is not assigned to this project');
    }
  }
  if (patch.work_type && patch.work_type !== (before.work_type || 'client')) {
    const { data: allocation } = await supabase.from('invoice_time_entry_allocations').select('id').eq('time_entry_id', entryId).limit(1).maybeSingle();
    if (allocation) throw badRequest('Invoiced time entry work type is locked');
  }
  const taskIds: string[] | undefined = Array.isArray(patch.task_ids) ? (patch.task_ids as string[]) : undefined;
  delete patch.task_ids;
  if (taskIds !== undefined && taskIds.length > 0) {
    await assertTasksInProject(supabase, taskIds, id);
  }
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

  // A task_ids-only PATCH leaves `patch` empty (links are handled below,
  // not by this update), and PostgREST rejects an empty update outright.
  // Observed live: the dev agent linking a task to the day's billing session
  // got a 500 and blocked. No columns to change means fetch, not update.
  let updated;
  if (Object.keys(patch).length > 0) {
    const { data, error } = await supabase
      .from('project_time_entries')
      .update(patch as any)
      .eq('id', entryId)
      .eq('project_id', id)
      .select(TIME_ENTRY_SELECT)
      .single();
    if (error) throw error;
    updated = data;
  } else {
    const { data, error } = await supabase
      .from('project_time_entries')
      .select(TIME_ENTRY_SELECT)
      .eq('id', entryId)
      .eq('project_id', id)
      .single();
    if (error) throw error;
    updated = data;
  }

  if (taskIds !== undefined) {
    await supabase.from('time_entry_tasks').delete().eq('time_entry_id', entryId);
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length > 0) {
      const { error: linkError } = await supabase
        .from('time_entry_tasks')
        .insert(uniqueTaskIds.map((linkedTaskId) => ({ time_entry_id: entryId, task_id: linkedTaskId })));
      if (linkError) throw linkError;
    }
  }
  const data = taskIds !== undefined
    ? { ...mapTimeEntryRow(updated), task_ids: [...new Set(taskIds)] }
    : mapTimeEntryRow(updated);

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

  return success(sanitizeTimeEntryForAccess(data as unknown as Record<string, unknown>, access, 'api'));
}, { schema: updateTimeEntrySchema, permission: ['time.manage_own', 'time.manage_all'] });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access, scopes }) => {
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
  if (!apiKeyAllows(access, scopes, 'time.manage_all') && before.approval_status === 'approved') {
    throw badRequest('Approved time cannot be deleted');
  }

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
}, { permission: ['time.manage_own', 'time.manage_all'] });
