import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden, notFound } from '@/lib/api/errors';
import { patchTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';

export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access }) => {
  requireAgentsEnabled();

  const { data, error } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (error || !data) throw notFound('Suggestion');
  if (!accessAllowsProject(access, data.project_id, 'api')) throw forbidden('Project scope denied');
  return success(data);
}, { permission: ['suggestions.create', 'suggestions.manage'] });

export const PATCH = withApi<any, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) throw notFound('Suggestion');
  if (!accessAllowsProject(access, before.project_id, 'api')) throw forbidden('Project scope denied');
  const canReview = scopes.includes('suggestions.manage')
    && accessAllows(access, 'suggestions.manage', 'api');
  if (!canReview && before.proposed_by !== teamMemberId) {
    throw forbidden('This API key can only update its own suggestions');
  }

  const updated = await patchTaskSuggestion(supabase, params.id, body);

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/task-suggestions/${params.id}`,
    entityType: 'suggestion',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(updated);
}, { schema: updateSuggestionSchema, permission: ['suggestions.create', 'suggestions.manage'] });
