import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

const reviewSchema = z.object({
  entry_ids: z.array(z.string().uuid()).min(1),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(2000).nullable().optional(),
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const review = body as z.infer<typeof reviewSchema>;
  const { data, error } = await supabase.rpc('review_time_entries_api', {
    p_project_id: params.id,
    p_entry_ids: review.entry_ids,
    p_decision: review.decision,
    p_reason: review.reason || null,
    p_reviewer_id: teamMemberId,
  });

  if (error) {
    if (error.message.includes('not found')
      || error.message.includes('project')
      || error.message.includes('self-approved')
      || error.message.includes('Compensation rate missing')) {
      throw badRequest(error.message);
    }
    throw error;
  }

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/time-entries/review`,
    entityType: 'time_entry_review',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    requestBody: review,
    afterSnapshot: data,
    statusCode: 200,
  });
  return success(data || []);
}, { schema: reviewSchema, permission: 'time.approve' });
