import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination } from '@/lib/api/pagination';
import { forbidden, badRequest } from '@/lib/api/errors';
import { insertTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  requireAgentsEnabled();

  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');
  const projectId = searchParams.get('project_id');
  const goalId = searchParams.get('goal_id');
  const proposedBy = searchParams.get('proposed_by');

  let query = supabase
    .from('task_suggestions')
    .select('*', { count: 'exact' });

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
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
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

  const suggestion = await insertTaskSuggestion(supabase, {
    ...body,
    proposed_by: teamMemberId,
    status: 'pending',
  });

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

  // Notify admin team members about the new suggestion (respects notification prefs)
  const { data: admins } = await supabase
    .from('team_members')
    .select('id, name, notification_prefs')
    .eq('role', 'admin');

  if (admins && admins.length > 0) {
    for (const admin of admins) {
      // Skip if admin explicitly disabled agent_suggestions notifications
      const prefs = (admin as any).notification_prefs;
      if (prefs?.agent_suggestions === false) continue;

      supabase.rpc('upsert_notification', {
        p_user_id: admin.id,
        p_title: `New suggestion from ${member.name || 'Agent'}`,
        p_message: suggestion.title,
        p_link: '/agent',
        p_entity_type: 'suggestion',
        p_entity_id: suggestion.id,
      }).then(() => {}, () => {});
    }
  }

  return created(suggestion);
}, { schema: createSuggestionSchema });
