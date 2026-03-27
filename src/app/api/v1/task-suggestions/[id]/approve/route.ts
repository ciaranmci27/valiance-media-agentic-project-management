import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { approveSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound, badRequest } from '@/lib/api/errors';
import { approveTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi<any, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) throw notFound('Suggestion');
  if (before.status !== 'pending' && before.status !== 'needs_info') {
    throw badRequest(`Cannot approve a suggestion with status "${before.status}"`);
  }

  const reviewedBy = teamMemberId || apiKeyId;
  const { ai_managed, ...taskOverrides } = (body || {}) as any;
  const result = await approveTaskSuggestion(supabase, params.id, taskOverrides, reviewedBy, ai_managed);

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/task-suggestions/${params.id}/approve`,
    entityType: 'suggestion',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: result.suggestion,
    statusCode: 200,
  });

  return success({ suggestion: result.suggestion, task: result.task });
}, { schema: approveSuggestionSchema });
