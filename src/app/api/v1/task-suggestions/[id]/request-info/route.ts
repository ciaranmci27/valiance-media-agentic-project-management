import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requestInfoSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound, badRequest, forbidden } from '@/lib/api/errors';
import { requestInfoTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';

export const POST = withApi<any, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) throw notFound('Suggestion');
  if (!accessAllowsProject(access, before.project_id, 'api')) throw forbidden('Project scope denied');
  if (before.status !== 'pending') {
    throw badRequest(`Cannot request info on a suggestion with status "${before.status}"`);
  }

  const reviewedBy = teamMemberId || apiKeyId;
  const updated = await requestInfoTaskSuggestion(supabase, params.id, body.info_request, reviewedBy);

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/task-suggestions/${params.id}/request-info`,
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
}, { schema: requestInfoSchema, permission: 'suggestions.manage' });
