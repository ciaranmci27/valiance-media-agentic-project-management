import { withApi } from '@/lib/api/middleware';
import { success, created, paginated } from '@/lib/api/response';
import { createGoalSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination, sanitizeSearch } from '@/lib/api/pagination';
import { insertGoal } from '@/lib/supabase/queries';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams }) => {
  const projectId = params.id;
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');

  let query = supabase
    .from('project_goals')
    .select('*', { count: 'exact' })
    .eq('project_id', projectId)
    .is('archived_at', null);

  if (status) query = query.eq('status', status);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi<any, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();
  const projectId = params.id;

  // Verify project exists
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr || !project) throw notFound('Project');

  const goal = await insertGoal(supabase, {
    ...body,
    project_id: projectId,
    created_by: teamMemberId,
  });

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${projectId}/goals`,
    entityType: 'goal',
    entityId: goal.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: goal,
    statusCode: 201,
  });

  return created(goal);
}, { schema: createGoalSchema });
