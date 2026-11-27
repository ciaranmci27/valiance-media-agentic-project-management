import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { bulkApproveSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { approveTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';
import { linkApprovedSuggestionEmail } from '@/lib/api/suggestion-email';
import { gateSuggestionApproval } from '@/lib/api/agent-access';

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled(access);

  const { ids } = body as { ids: string[] };
  const reviewedBy = teamMemberId || apiKeyId;

  const results: { id: string; success: boolean; task_id?: string; error?: string; reason?: string; approval_id?: string }[] = [];

  for (const id of ids) {
    try {
      const { data: suggestion } = await supabase.from('task_suggestions').select('id, status, project_id, title, assigned_to').eq('id', id).maybeSingle();
      if (!suggestion) { results.push({ id, success: false, error: 'Suggestion not found' }); continue; }
      // A suggestion in a project in Trash is out of reach with it.
      const { data: liveProject } = await supabase.from('projects').select('id').eq('id', suggestion.project_id).is('deleted_at', null).maybeSingle();
      if (!liveProject) { results.push({ id, success: false, error: 'Suggestion not found' }); continue; }
      if (!accessAllowsProject(access, suggestion.project_id, 'api')) { results.push({ id, success: false, error: 'Project scope denied' }); continue; }
      if (suggestion.status !== 'pending' && suggestion.status !== 'needs_info') { results.push({ id, success: false, error: `Cannot approve a suggestion with status "${suggestion.status}"` }); continue; }
      // The agent it would go to, for the approver: refused or waiting on its managers before any task is made.
      const pending = await gateSuggestionApproval(supabase, access, teamMemberId, suggestion);
      if (pending) {
        results.push({ id, success: false, error: pending.message, reason: 'ask_first', approval_id: pending.approval_id });
        continue;
      }
      const result = await approveTaskSuggestion(supabase, id, {}, reviewedBy);
      results.push({ id, success: true, task_id: result.task.id });
      // Made from an email: the email is linked to the new task, when the approver reads its inbox.
      if (teamMemberId) await linkApprovedSuggestionEmail(supabase, { suggestionId: id, memberId: teamMemberId, access, channel: 'api' })
        .catch((error) => console.error('[suggestions] bulk approve: linking the email failed:', error));

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
      results.push({ id, success: false, error: err.message || 'Failed to approve', ...(err?.details?.reason ? { reason: err.details.reason } : {}) });
    }
  }

  return success({
    approved: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  });
}, { schema: bulkApproveSchema, permission: 'suggestions.manage' });
