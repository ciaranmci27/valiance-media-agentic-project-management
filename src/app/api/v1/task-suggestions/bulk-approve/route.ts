import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { bulkApproveSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { approveTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  const { ids } = body as { ids: string[] };
  const reviewedBy = teamMemberId || apiKeyId;

  const results: { id: string; success: boolean; task_id?: string; error?: string }[] = [];

  for (const id of ids) {
    try {
      const { data: suggestion } = await supabase.from('task_suggestions').select('status, project_id').eq('id', id).maybeSingle();
      if (!suggestion) { results.push({ id, success: false, error: 'Suggestion not found' }); continue; }
      if (!accessAllowsProject(access, suggestion.project_id, 'api')) { results.push({ id, success: false, error: 'Project scope denied' }); continue; }
      if (suggestion.status !== 'pending' && suggestion.status !== 'needs_info') { results.push({ id, success: false, error: `Cannot approve a suggestion with status "${suggestion.status}"` }); continue; }
      const result = await approveTaskSuggestion(supabase, id, {}, reviewedBy);
      results.push({ id, success: true, task_id: result.task.id });

      logAudit(supabase, {
        method: 'POST',
        endpoint: '/api/v1/task-suggestions/bulk-approve',
        entityType: 'suggestion',
        entityId: id,
        apiKeyId,
        teamMemberId,
        afterSnapshot: result.suggestion,
        statusCode: 200,
      });
    } catch (err: any) {
      results.push({ id, success: false, error: err.message || 'Failed to approve' });
    }
  }

  return success({
    approved: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  });
}, { schema: bulkApproveSchema, permission: 'suggestions.manage' });
