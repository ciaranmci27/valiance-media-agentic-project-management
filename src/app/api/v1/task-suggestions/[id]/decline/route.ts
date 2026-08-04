import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound, badRequest, forbidden } from '@/lib/api/errors';
import { declineTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';

// Decline: "we do not want this, no comment." Unlike reject it takes no reason
// and writes no lesson_learned context entry, so it is safe for housekeeping
// (declining sibling instances of a pattern already approved as one class-level
// task) without teaching the auditing agent that the finding class is unwanted.
// It is also excluded from per-question approval-rate tallies for that reason.
export const POST = withApi<any, { id: string }>(async ({ supabase, params, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) throw notFound('Suggestion');
  if (!accessAllowsProject(access, before.project_id, 'api')) throw forbidden('Project scope denied');
  if (before.status !== 'pending' && before.status !== 'needs_info') {
    throw badRequest(`Cannot decline a suggestion with status "${before.status}"`);
  }

  const reviewedBy = teamMemberId || apiKeyId;
  const updated = await declineTaskSuggestion(supabase, params.id, reviewedBy);

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/task-suggestions/${params.id}/decline`,
    entityType: 'suggestion',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(updated);
}, { permission: 'suggestions.manage' });
