import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination } from '@/lib/api/pagination';
import { forbidden, badRequest } from '@/lib/api/errors';
import { insertTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  requireAgentsEnabled();

  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');
  const projectId = searchParams.get('project_id');
  const goalId = searchParams.get('goal_id');
  const proposedBy = searchParams.get('proposed_by');

  let query = supabase
    .from('task_suggestions')
    .select('*', { count: 'exact' });

  if (!accessAllows(access, 'projects.read_all', 'api')) {
    if (access.project_ids.length === 0) return paginated([], { page, limit, total: 0 });
    query = query.in('project_id', access.project_ids);
  }

  if (status) query = query.eq('status', status);
  if (projectId) query = query.eq('project_id', projectId);
  if (goalId) query = query.eq('goal_id', goalId);
  if (proposedBy) query = query.eq('proposed_by', proposedBy);
  const taskType = searchParams.get('task_type');
  if (taskType) query = query.eq('task_type', taskType);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: ['suggestions.create', 'suggestions.manage'] });

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  if (!teamMemberId) {
    throw badRequest('API key must be linked to an agent team member to create suggestions');
  }

  // Verify the linked team member is an agent
  const { data: member } = await supabase
    .from('team_members')
    .select('id, role, name')
    .eq('id', teamMemberId)
    .maybeSingle();

  if (!member || member.role !== 'agent') {
    throw forbidden('Only agent team members can create suggestions');
  }

  const suggestionInput = body as { project_id: string; goal_id: string };
  if (!accessAllowsProject(access, suggestionInput.project_id, 'api')) {
    throw forbidden('Project scope denied');
  }
  const { data: goal } = await supabase
    .from('project_goals')
    .select('id')
    .eq('id', suggestionInput.goal_id)
    .eq('project_id', suggestionInput.project_id)
    .maybeSingle();
  if (!goal) throw badRequest('goal_id must belong to project_id');

  // Bundling: resolve the shared key server-side so the proposer cannot
  // invent keys or reach across projects. The target must be a PENDING
  // suggestion in the same project; anything else drops the bundle silently
  // (a failed bundle must never block a valid finding). A target Ciaran
  // manually unbundled (metadata.unbundled) is left alone: his arrangement
  // always wins over the proposer's.
  const { bundle_with, ...suggestionBody } = body as Record<string, unknown> & { bundle_with?: string | null };
  let bundleKey: string | null = null;
  if (bundle_with) {
    const { data: target } = await supabase
      .from('task_suggestions')
      .select('id, project_id, status, bundle_key, metadata')
      .eq('id', bundle_with)
      .maybeSingle();
    const unbundled = Boolean((target?.metadata as Record<string, unknown> | null)?.unbundled);
    if (target && target.status === 'pending' && target.project_id === suggestionInput.project_id && !unbundled) {
      bundleKey = (target.bundle_key as string | null) ?? crypto.randomUUID();
      if (!target.bundle_key) {
        await supabase.from('task_suggestions').update({ bundle_key: bundleKey }).eq('id', target.id);
      }
    }
  }

  const suggestion = await insertTaskSuggestion(supabase, {
    ...suggestionBody,
    ...(bundleKey ? { bundle_key: bundleKey } : {}),
    proposed_by: teamMemberId,
    status: 'pending',
  } as Parameters<typeof insertTaskSuggestion>[1]);

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/task-suggestions',
    entityType: 'suggestion',
    entityId: suggestion.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: suggestion,
    statusCode: 201,
  });

  // Deliberately NO notification here. The Agent tab's badge already counts
  // pending suggestions and links to this exact screen, so a notification
  // saying one arrived duplicates a signal already on screen. Two indicators
  // for one item read as twice the work and make an empty-ish queue feel full.
  //
  // The rule for this app: notify only about things that have NO other visual
  // indicator. Anything already carrying a badge, a count, or a column is
  // surfaced; adding a notification on top subtracts from the value of every
  // other notification.

  return created(suggestion);
}, { schema: createSuggestionSchema, permission: 'suggestions.create' });
