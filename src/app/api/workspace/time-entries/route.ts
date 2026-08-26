import { NextResponse } from 'next/server';
import { accessAllows, accessAllowsProject, requireSessionAccess, sanitizeTimeEntryForAccess } from '@/lib/api/access';
import { fetchMemberBillingMultiplier, resolveProjectHourlyRate } from '@/lib/supabase/queries';

type EntryPatch = {
  member_id?: string;
  start_time?: string;
  end_time?: string | null;
  segments?: Array<{ start: string; end: string | null }>;
  description?: string;
  work_type?: 'client' | 'internal';
  task_ids?: string[];
};

// Every linked task must belong to the entry's project.
async function validateTaskLinks(
  service: { from: (table: string) => any },
  taskIds: string[],
  projectId: string,
): Promise<string | null> {
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return null;
  const { data: tasks } = await service.from('tasks').select('id, project_id').in('id', uniqueIds);
  const found = new Map((tasks || []).map((t: { id: string; project_id: string }) => [t.id, t.project_id]));
  for (const id of uniqueIds) {
    if (found.get(id) !== projectId) return 'task_ids must reference existing tasks in this project';
  }
  return null;
}

// Replace the full linked-task list for an entry.
async function replaceTaskLinks(
  service: { from: (table: string) => any },
  entryId: string,
  taskIds: string[],
): Promise<void> {
  await service.from('time_entry_tasks').delete().eq('time_entry_id', entryId);
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length > 0) {
    await service.from('time_entry_tasks').insert(uniqueIds.map((taskId) => ({ time_entry_id: entryId, task_id: taskId })));
  }
}

function withTaskIds<T extends Record<string, unknown>>(row: T): T & { task_ids: string[] } {
  const { time_entry_tasks, ...entry } = row as any;
  return { ...entry, task_ids: (time_entry_tasks || []).map((link: any) => link.task_id) };
}

function responseError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// Guards against malformed timing that would feed negative or double-counted
// hours into payroll: an end before its start, or overlapping work segments.
function validateEntryTiming(
  startTime: string,
  endTime: string | null | undefined,
  segments: Array<{ start: string; end: string | null }> | undefined,
): string | null {
  const start = Date.parse(startTime);
  if (Number.isNaN(start)) return 'Invalid start time';
  if (endTime != null) {
    const end = Date.parse(endTime);
    if (Number.isNaN(end)) return 'Invalid end time';
    if (end < start) return 'End time must not be before start time';
  }
  if (segments !== undefined) {
    if (!Array.isArray(segments) || segments.length === 0) return 'Segments must be a non-empty list';
    const closed: Array<[number, number]> = [];
    for (const seg of segments) {
      const segStart = Date.parse(seg?.start);
      if (Number.isNaN(segStart)) return 'Invalid segment start time';
      if (seg?.end == null) continue; // an open (still-running) segment
      const segEnd = Date.parse(seg.end);
      if (Number.isNaN(segEnd)) return 'Invalid segment end time';
      if (segEnd < segStart) return 'Segment end must not be before its start';
      closed.push([segStart, segEnd]);
    }
    closed.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < closed.length; i += 1) {
      if (closed[i][0] < closed[i - 1][1]) return 'Time segments must not overlap';
    }
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const projectId = new URL(request.url).searchParams.get('project_id');
  if (projectId && !accessAllowsProject(access, projectId)) return responseError('Project access denied', 403);

  const canManageAll = accessAllows(access, 'time.manage_all', 'app');
  const canReadAll = accessAllows(access, 'time.read_all', 'app') || canManageAll;
  if (!canReadAll && !accessAllows(access, 'time.manage_own', 'app')) return responseError('Forbidden', 403);

  let query = service.from('project_time_entries').select('*, time_entry_tasks ( task_id )').order('start_time', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);
  if (!canReadAll) query = query.eq('member_id', memberId);
  if (!accessAllows(access, 'projects.read_all', 'app')) {
    if (access.project_ids.length === 0) return NextResponse.json({ data: [] });
    query = query.in('project_id', access.project_ids);
  }

  const { data, error } = await query;
  if (error) return responseError(error.message, 500);
  return NextResponse.json({
    data: (data || []).map((entry) => sanitizeTimeEntryForAccess(withTaskIds(entry), access)),
  });
}

export async function POST(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  if (!accessAllows(access, 'time.manage_own', 'app') && !accessAllows(access, 'time.manage_all', 'app')) return responseError('Forbidden', 403);
  const body = await request.json() as EntryPatch & { project_id?: string };
  if (!body.project_id || !body.start_time) return responseError('Project and start time are required');
  if (!accessAllowsProject(access, body.project_id)) return responseError('Project access denied', 403);
  const postTimingError = validateEntryTiming(body.start_time, body.end_time, body.segments);
  if (postTimingError) return responseError(postTimingError, 422);

  const { data: project, error: projectError } = await service
    .from('projects')
    .select('id, hourly_tracking, time_tracking_enabled, hourly_rate')
    .eq('id', body.project_id)
    .maybeSingle();
  if (projectError || !project) return responseError('Project not found', 404);
  if (!(project as { time_tracking_enabled?: boolean }).time_tracking_enabled && !project.hourly_tracking) {
    return responseError('Time tracking is not enabled for this project');
  }

  const targetMemberId = accessAllows(access, 'time.manage_all', 'app') && body.member_id
    ? body.member_id
    : memberId;
  const { data: targetMember } = await service.from('team_members').select('id, status').eq('id', targetMemberId).maybeSingle();
  if (!targetMember || targetMember.status !== 'active') return responseError('Active team member not found', 422);
  if (targetMemberId !== memberId) {
    const { data: assignment } = await service.from('project_members').select('project_id').eq('project_id', body.project_id).eq('member_id', targetMemberId).maybeSingle();
    if (!assignment) return responseError('Team member is not assigned to this project', 422);
  }
  // Starting a timer (no end_time) while one is already unfinalized would
  // create a second running entry the dashboard never shows (own entries are
  // excluded from the teammates list), silently billing forever. The client
  // checks too, but a double-click races its own optimistic state; this is
  // the guard that holds. Mirrors the v1 route.
  if ((body.end_time ?? null) === null) {
    const { data: alreadyRunning } = await service
      .from('project_time_entries')
      .select('id')
      .eq('project_id', body.project_id)
      .eq('member_id', targetMemberId)
      .is('end_time', null)
      .limit(1)
      .maybeSingle();
    if (alreadyRunning) return responseError('A timer is already running for this member on this project', 409);
  }
  const hourlyRate = await resolveProjectHourlyRate(
    service,
    body.project_id,
    body.start_time,
    Number(project.hourly_rate) || undefined,
  );
  const billingMultiplier = await fetchMemberBillingMultiplier(service, targetMemberId);
  const taskIds: string[] = Array.isArray(body.task_ids) ? body.task_ids : [];
  if (taskIds.length > 0) {
    const taskLinkError = await validateTaskLinks(service, taskIds, body.project_id);
    if (taskLinkError) return responseError(taskLinkError, 422);
  }
  const payload = {
    project_id: body.project_id,
    member_id: targetMemberId,
    start_time: body.start_time,
    end_time: body.end_time ?? null,
    segments: body.segments || [{ start: body.start_time, end: body.end_time ?? null }],
    hourly_rate: hourlyRate,
    description: body.description || '',
    work_type: body.work_type || 'client',
    billing_multiplier: billingMultiplier,
  };
  let result = await service.from('project_time_entries').insert(payload).select().single();
  if (result.error?.message.includes('work_type')) {
    const legacyPayload: Partial<typeof payload> = { ...payload };
    delete legacyPayload.work_type;
    result = await service.from('project_time_entries').insert(legacyPayload).select().single();
  }
  if (result.error) return responseError(result.error.message, 500);
  if (taskIds.length > 0) {
    await replaceTaskLinks(service, result.data.id, taskIds);
  }
  return NextResponse.json({ data: sanitizeTimeEntryForAccess({ ...result.data, task_ids: [...new Set(taskIds)] }, access) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  if (!accessAllows(access, 'time.manage_own', 'app') && !accessAllows(access, 'time.manage_all', 'app')) return responseError('Forbidden', 403);
  const body = await request.json() as EntryPatch & { id?: string };
  if (!body.id) return responseError('Time entry id is required');

  const { data: existing } = await service
    .from('project_time_entries')
    .select('id, project_id, member_id, approval_status, work_type, start_time, end_time, segments')
    .eq('id', body.id)
    .maybeSingle();
  if (!existing) return responseError('Time entry not found', 404);
  const canManageAll = accessAllows(access, 'time.manage_all', 'app');
  if (!canManageAll && existing.member_id !== memberId) return responseError('Forbidden', 403);
  if (!canManageAll && existing.approval_status === 'approved') return responseError('Approved time cannot be edited', 409);
  if (!accessAllowsProject(access, existing.project_id)) return responseError('Project access denied', 403);

  if ('start_time' in body || 'end_time' in body || 'segments' in body) {
    const effectiveStart = body.start_time ?? (existing as { start_time: string }).start_time;
    const effectiveEnd = 'end_time' in body ? body.end_time : (existing as { end_time: string | null }).end_time;
    const effectiveSegments = 'segments' in body ? body.segments : undefined;
    const patchTimingError = validateEntryTiming(effectiveStart, effectiveEnd, effectiveSegments);
    if (patchTimingError) return responseError(patchTimingError, 422);
  }

  // Reopening a finalized entry (the resume-after-stop feature) must respect
  // the same one-unfinalized-entry-per-member invariant that POST enforces.
  if ('end_time' in body && body.end_time === null && existing.end_time !== null) {
    const { data: alreadyRunning } = await service
      .from('project_time_entries')
      .select('id')
      .eq('project_id', existing.project_id)
      .eq('member_id', existing.member_id)
      .is('end_time', null)
      .neq('id', existing.id)
      .limit(1)
      .maybeSingle();
    if (alreadyRunning) return responseError('A timer is already running for this member on this project', 409);
  }

  if (body.work_type && body.work_type !== (existing.work_type || 'client')) {
    const { data: allocation, error: allocationError } = await service
      .from('invoice_time_entry_allocations')
      .select('id')
      .eq('time_entry_id', existing.id)
      .limit(1)
      .maybeSingle();
    if (allocationError) return responseError(allocationError.message, 500);
    if (allocation) return responseError('Invoiced time entry work type is locked', 409);
  }

  const patch: EntryPatch & { hourly_rate?: number } = {};
  for (const key of ['start_time', 'end_time', 'segments', 'description', 'work_type'] as const) {
    if (key in body) Object.assign(patch, { [key]: body[key] });
  }
  const taskIds: string[] | undefined = Array.isArray(body.task_ids) ? body.task_ids : undefined;
  if (taskIds !== undefined && taskIds.length > 0) {
    const taskLinkError = await validateTaskLinks(service, taskIds, existing.project_id);
    if (taskLinkError) return responseError(taskLinkError, 422);
  }
  if (canManageAll && body.member_id) {
    const { data: targetMember } = await service.from('team_members').select('id, status').eq('id', body.member_id).maybeSingle();
    if (!targetMember || targetMember.status !== 'active') return responseError('Active team member not found', 422);
    if (body.member_id !== memberId) {
      const { data: assignment } = await service.from('project_members').select('project_id').eq('project_id', existing.project_id).eq('member_id', body.member_id).maybeSingle();
      if (!assignment) return responseError('Team member is not assigned to this project', 422);
    }
    patch.member_id = body.member_id;
  }
  if (body.start_time) patch.hourly_rate = await resolveProjectHourlyRate(service, existing.project_id, body.start_time);
  // Same empty-patch guard as the v1 route: a task_ids-only edit (the entry
  // editor's task picker) must not send an empty update.
  let result = Object.keys(patch).length > 0
    ? await service.from('project_time_entries').update(patch).eq('id', body.id).select('*, time_entry_tasks ( task_id )').single()
    : await service.from('project_time_entries').select('*, time_entry_tasks ( task_id )').eq('id', body.id).single();
  if (result.error?.message.includes('work_type')) {
    const legacyPatch: typeof patch = { ...patch };
    delete legacyPatch.work_type;
    result = await service.from('project_time_entries').update(legacyPatch).eq('id', body.id).select('*, time_entry_tasks ( task_id )').single();
  }
  if (result.error) return responseError(result.error.message, 500);
  if (taskIds !== undefined) {
    await replaceTaskLinks(service, body.id, taskIds);
    return NextResponse.json({ data: sanitizeTimeEntryForAccess({ ...withTaskIds(result.data), task_ids: [...new Set(taskIds)] }, access) });
  }
  return NextResponse.json({ data: sanitizeTimeEntryForAccess(withTaskIds(result.data), access) });
}

export async function DELETE(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  if (!accessAllows(access, 'time.manage_own', 'app') && !accessAllows(access, 'time.manage_all', 'app')) return responseError('Forbidden', 403);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return responseError('Time entry id is required');

  const { data: existing } = await service
    .from('project_time_entries')
    .select('id, project_id, member_id, approval_status')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return responseError('Time entry not found', 404);
  const canManageAll = accessAllows(access, 'time.manage_all', 'app');
  if (!canManageAll && existing.member_id !== memberId) return responseError('Forbidden', 403);
  if (!canManageAll && existing.approval_status === 'approved') return responseError('Approved time cannot be deleted', 409);
  if (!accessAllowsProject(access, existing.project_id)) return responseError('Project access denied', 403);
  const { error } = await service.from('project_time_entries').delete().eq('id', id);
  if (error) return responseError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
