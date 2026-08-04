import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { bulkDeclineSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { declineTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';

// Bulk form of decline: "we do not want these, no comment". Like the single
// route it records no reason and writes no lesson_learned entries, which is the
// point: declining a batch of sibling findings after approving one class-level
// fix must not teach the auditing agent that the finding class was unwanted.
export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  const { ids } = body as { ids: string[] };
  const reviewedBy = teamMemberId || apiKeyId;

  const results: { id: string; success: boolean; error?: string }[] = [];

  for (const id of ids) {
    try {
      const { data: suggestion } = await supabase.from('task_suggestions').select('status, project_id').eq('id', id).maybeSingle();
      if (!suggestion) { results.push({ id, success: false, error: 'Suggestion not found' }); continue; }
      if (!accessAllowsProject(access, suggestion.project_id, 'api')) { results.push({ id, success: false, error: 'Project scope denied' }); continue; }
      if (suggestion.status !== 'pending' && suggestion.status !== 'needs_info') { results.push({ id, success: false, error: `Cannot decline a suggestion with status "${suggestion.status}"` }); continue; }
      const updated = await declineTaskSuggestion(supabase, id, reviewedBy);
      results.push({ id, success: true });

      logAudit(supabase, {
        method: 'POST',
        endpoint: '/api/v1/task-suggestions/bulk-decline',
        entityType: 'suggestion',
        entityId: id,
        apiKeyId,
        teamMemberId,
        afterSnapshot: updated,
        statusCode: 200,
      });
    } catch (err: any) {
      results.push({ id, success: false, error: err.message || 'Failed to decline' });
    }
  }

  return success({
    declined: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  });
}, { schema: bulkDeclineSchema, permission: 'suggestions.manage' });
