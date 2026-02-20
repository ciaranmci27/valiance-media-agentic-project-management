import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateGoalSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound } from '@/lib/api/errors';
import { patchGoal, archiveGoal } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi<unknown, { id: string; goalId: string }>(async ({ supabase, params }) => {
  const { data: goal, error } = await supabase
    .from('project_goals')
    .select('*')
    .eq('id', params.goalId)
    .eq('project_id', params.id)
    .maybeSingle();

  if (error || !goal) throw notFound('Goal');

  // Rollup stats
  const [suggestionsResult, tasksResult] = await Promise.all([
    supabase.from('task_suggestions').select('status', { count: 'exact' }).eq('goal_id', params.goalId),
    supabase.from('tasks').select('status', { count: 'exact' }).eq('project_goal_id', params.goalId),
  ]);

  const suggestions = suggestionsResult.data || [];
  const tasks = tasksResult.data || [];

  return success({
    ...goal,
    stats: {
      pending_suggestions: suggestions.filter((s: any) => s.status === 'pending').length,
      approved_suggestions: suggestions.filter((s: any) => s.status === 'approved').length,
      total_suggestions: suggestions.length,
      total_tasks: tasks.length,
      completed_tasks: tasks.filter((t: any) => t.status === 'done').length,
      in_progress_tasks: tasks.filter((t: any) => t.status === 'in_progress').length,
    },
  });
});

export const PATCH = withApi<any, { id: string; goalId: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('project_goals')
    .select('*')
    .eq('id', params.goalId)
    .maybeSingle();
  if (!before) throw notFound('Goal');

  const goal = await patchGoal(supabase, params.goalId, body);

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${params.id}/goals/${params.goalId}`,
    entityType: 'goal',
    entityId: params.goalId,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: goal,
    statusCode: 200,
  });

  return success(goal);
}, { schema: updateGoalSchema });

export const DELETE = withApi<unknown, { id: string; goalId: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('project_goals')
    .select('*')
    .eq('id', params.goalId)
    .maybeSingle();
  if (!before) throw notFound('Goal');

  const goal = await archiveGoal(supabase, params.goalId);

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${params.id}/goals/${params.goalId}`,
    entityType: 'goal',
    entityId: params.goalId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: goal,
    statusCode: 200,
  });

  return success({ archived: true });
});
