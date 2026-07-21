import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { rejectSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound, badRequest, forbidden } from '@/lib/api/errors';
import { rejectTaskSuggestion } from '@/lib/supabase/queries';
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
  if (before.status === 'approved' || before.status === 'rejected') {
    throw badRequest(`Cannot reject a suggestion with status "${before.status}"`);
  }

  const reviewedBy = teamMemberId || apiKeyId;
  const updated = await rejectTaskSuggestion(supabase, params.id, body?.rejection_reason, reviewedBy);

  // Create lesson_learned context entry from rejection reason
  if (body?.rejection_reason) {
    supabase
      .from('project_context')
      .insert({
        project_id: before.project_id,
        category: 'lesson_learned',
        content: `Rejected suggestion: "${before.title}" - ${body.rejection_reason}`,
        source: 'human',
      })
      .then(() => {}, (err: any) => console.error('[reject] Failed to create lesson_learned context entry:', err));
  }

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/task-suggestions/${params.id}/reject`,
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
}, { schema: rejectSuggestionSchema, permission: 'suggestions.manage' });
