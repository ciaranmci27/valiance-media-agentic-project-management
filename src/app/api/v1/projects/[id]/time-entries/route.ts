import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createTimeEntrySchema, startTimerSchema } from '@/lib/schemas';
import { notFound, badRequest, forbidden } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { z } from 'zod';
import { fetchMemberBillingMultiplier, resolveProjectHourlyRate, TIME_ENTRY_SELECT, mapTimeEntryRow } from '@/lib/supabase/queries';
import { assertTasksInProject } from '@/lib/api/task-guards';
import { apiKeyAllows, sanitizeTimeEntryForAccess } from '@/lib/api/access';

// POST body: either a manual entry (start_time + end_time) or a timer start (no end_time)
const postSchema = z.union([createTimeEntrySchema, startTimerSchema]);

export const GET = withApi(async ({ supabase, params, searchParams, access, teamMemberId, scopes }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  // Verify project exists
  const { data: project } = await supabase.from('projects').select('id').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');

  // Optional filters
  const requestedMemberId = searchParams.get('member_id');
  const memberId = apiKeyAllows(access, scopes, 'time.read_all')
    ? requestedMemberId
    : teamMemberId;
  const running = searchParams.get('running'); // "true" = only running timers

  // Use !inner join when filtering by task so count is accurate.
  const taskId = searchParams.get('task_id');
  const taskJoin = taskId ? 'time_entry_tasks!inner ( task_id )' : 'time_entry_tasks ( task_id )';
  let query = supabase
    .from('project_time_entries')
    .select(`*, ${taskJoin}`, { count: 'exact' })
    .eq('project_id', id)
    .order('start_time', { ascending: false });

  if (memberId) query = query.eq('member_id', memberId);
  if (running === 'true') query = query.is('end_time', null);
  if (running === 'false') query = query.not('end_time', 'is', null);
  if (taskId) query = query.eq('time_entry_tasks.task_id', taskId);

  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  return paginated((data || []).map((entry) => sanitizeTimeEntryForAccess(mapTimeEntryRow(entry) as unknown as Record<string, unknown>, access, 'api')), { page, limit, total: count || 0 });
}, { permission: ['time.manage_own', 'time.read_all', 'time.manage_all'] });

/**
 * If a timezone is provided and the timestamp has no offset indicator
 * (no 'Z', '+', or '-' after the time), interpret the bare timestamp
 * in the given timezone and convert to UTC ISO string.
 */
function applyTimezone(timestamp: string, timezone: string): string {
  // Already has an offset — leave it alone
  if (/[Zz]$/.test(timestamp) || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }

  // Parse the bare datetime as UTC so the algorithm is server-timezone-independent
  const d = new Date(timestamp.endsWith('Z') ? timestamp : timestamp + 'Z');
  if (isNaN(d.getTime())) return timestamp;

  // Use Intl to find the UTC offset for this timezone at the given instant.
  // We format in the target timezone, then compute the difference.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find(p => p.type === type)?.value || '0';
  const tzDate = new Date(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`
  );

  // offset = tzDate(UTC-interpreted) - d(UTC-interpreted)
  // This tells us how far ahead the timezone is from UTC
  const offsetMs = tzDate.getTime() - d.getTime();

  // The bare timestamp represents local time in the given timezone.
  // To convert to UTC, subtract the offset.
  const utc = new Date(d.getTime() - offsetMs);
  return utc.toISOString();
}

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id } = params as any;
  const requestedEntry = body as z.infer<typeof postSchema>;
  const entry = {
    ...requestedEntry,
    member_id: apiKeyAllows(access, scopes, 'time.manage_all')
      ? requestedEntry.member_id
      : teamMemberId,
  };

  // Verify project exists
  const { data: project } = await supabase.from('projects').select('id, hourly_tracking, time_tracking_enabled').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');
  if (!(project as any).time_tracking_enabled && !project.hourly_tracking) {
    throw badRequest('Time tracking is not enabled for this project');
  }
  const { data: targetMember } = await supabase.from('team_members').select('id, status').eq('id', entry.member_id).maybeSingle();
  if (!targetMember || targetMember.status !== 'active') throw badRequest('Active team member not found');
  if (entry.member_id !== teamMemberId) {
    const { data: assignment } = await supabase.from('project_members').select('project_id').eq('project_id', id).eq('member_id', entry.member_id).maybeSingle();
    if (!assignment) throw forbidden('Team member is not assigned to this project');
  }

  // Optional task links: every task must belong to this project.
  const taskIds: string[] = Array.isArray((entry as any).task_ids) ? (entry as any).task_ids : [];
  if (taskIds.length > 0) {
    await assertTasksInProject(supabase, taskIds, id);
  }

  const isTimer = !('end_time' in entry) || !entry.end_time;

  // If starting a timer, check no running timer exists for this member+project
  if (isTimer) {
    const { data: existing } = await supabase
      .from('project_time_entries')
      .select('id')
      .eq('project_id', id)
      .eq('member_id', entry.member_id)
      .is('end_time', null)
      .maybeSingle();

    if (existing) throw badRequest('A timer is already running for this member on this project');
  }

  // Resolve timezone: explicit request field → user's stored preference → no conversion
  let timezone = 'timezone' in entry ? (entry as any).timezone as string | undefined : undefined;
  if (!timezone && teamMemberId) {
    const { data: member } = await supabase
      .from('team_members')
      .select('timezone')
      .eq('id', teamMemberId)
      .maybeSingle();
    if (member?.timezone && member.timezone !== 'UTC') {
      timezone = member.timezone;
    }
  }

  let startTime = isTimer ? new Date().toISOString() : (entry as any).start_time;
  let endTime = isTimer ? null : (entry as any).end_time;

  if (!isTimer && timezone) {
    startTime = applyTimezone(startTime, timezone);
    if (endTime) endTime = applyTimezone(endTime, timezone);
  }

  // Initialize segments: for a live timer, a single open segment; for a
  // manual entry, a single closed segment spanning the full range.
  const segments = isTimer
    ? [{ start: startTime, end: null }]
    : [{ start: startTime, end: endTime }];
  const hourlyRate = await resolveProjectHourlyRate(
    supabase,
    id,
    startTime,
    Number((project as any).hourly_rate) || undefined,
  );
  const billingMultiplier = await fetchMemberBillingMultiplier(supabase, entry.member_id);

  const insertPayload = {
    project_id: id,
    member_id: entry.member_id,
    start_time: startTime,
    end_time: endTime,
    segments,
    hourly_rate: hourlyRate,
    description: entry.description || '',
    work_type: entry.work_type || 'client',
    billing_multiplier: billingMultiplier,
  };

  const { data: inserted, error } = await supabase
    .from('project_time_entries')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;

  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length > 0) {
    const { error: linkError } = await supabase
      .from('time_entry_tasks')
      .insert(uniqueTaskIds.map((linkedTaskId) => ({ time_entry_id: inserted.id, task_id: linkedTaskId })));
    if (linkError) throw linkError;
  }
  const data = { ...inserted, task_ids: uniqueTaskIds };

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${id}/time-entries`,
    entityType: 'time_entry',
    entityId: data.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: data,
    statusCode: 201,
  });

  return created(sanitizeTimeEntryForAccess(data, access, 'api'));
}, { schema: postSchema, permission: ['time.manage_own', 'time.manage_all'] });
