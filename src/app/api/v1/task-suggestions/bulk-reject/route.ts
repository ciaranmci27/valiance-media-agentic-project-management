import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { bulkRejectSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { rejectTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();

  const { ids, rejection_reason } = body as { ids: string[]; rejection_reason?: string };
  const reviewedBy = teamMemberId || apiKeyId;

  const results: { id: string; success: boolean; error?: string }[] = [];

  for (const id of ids) {
    try {
      const updated = await rejectTaskSuggestion(supabase, id, rejection_reason, reviewedBy);
      results.push({ id, success: true });

      logAudit(supabase, {
        method: 'POST',
        endpoint: '/api/v1/task-suggestions/bulk-reject',
        entityType: 'suggestion',
        entityId: id,
        apiKeyId,
        teamMemberId,
        afterSnapshot: updated,
        statusCode: 200,
      });
    } catch (err: any) {
      results.push({ id, success: false, error: err.message || 'Failed to reject' });
    }
  }

  return success({
    rejected: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  });
}, { schema: bulkRejectSchema });
