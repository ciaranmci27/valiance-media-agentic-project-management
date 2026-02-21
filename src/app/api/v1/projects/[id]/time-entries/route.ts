import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createTimeEntrySchema, startTimerSchema } from '@/lib/schemas';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { z } from 'zod';

// POST body: either a manual entry (start_time + end_time) or a timer start (no end_time)
const postSchema = z.union([createTimeEntrySchema, startTimerSchema]);

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  // Verify project exists
  const { data: project } = await supabase.from('projects').select('id').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');

  // Optional filters
  const memberId = searchParams.get('member_id');
  const running = searchParams.get('running'); // "true" = only running timers

  let query = supabase
    .from('project_time_entries')
    .select('*', { count: 'exact' })
    .eq('project_id', id)
    .order('start_time', { ascending: false });

  if (memberId) query = query.eq('member_id', memberId);
  if (running === 'true') query = query.is('end_time', null);
  if (running === 'false') query = query.not('end_time', 'is', null);

  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const entry = body as z.infer<typeof postSchema>;

  // Verify project exists
  const { data: project } = await supabase.from('projects').select('id, hourly_tracking').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');
  if (!project.hourly_tracking) throw badRequest('Hourly tracking is not enabled for this project');

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

  const insertPayload = {
    project_id: id,
    member_id: entry.member_id,
    start_time: isTimer ? new Date().toISOString() : (entry as any).start_time,
    end_time: isTimer ? null : (entry as any).end_time,
    description: entry.description || '',
  };

  const { data, error } = await supabase
    .from('project_time_entries')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;

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

  return created(data);
}, { schema: postSchema });
