import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { memberInboxIds } from '@/lib/inbound-email/agent-access';
import { markSummarizedSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/**
 * Marks triage as included in a summary (and any older unsummarized triage
 * of the same emails). All or nothing: an id that is not in the member's
 * inboxes marks nothing and is reported.
 */
export const POST = withApi<{ triage_ids: string[] }>(async ({ supabase, body, teamMemberId, apiKeyId }) => {
  const inboxIds = await memberInboxIds(supabase, teamMemberId);
  const { data, error } = await supabase.rpc('email_mark_triage_summarized', {
    p_triage_ids: body.triage_ids,
    p_inbox_ids: inboxIds,
  });
  if (error) throw error;
  const result = data as { marked: number; missing: string[] };
  if (result.missing.length > 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Some triage ids are not in your inboxes; nothing was marked', { missing: result.missing });
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/inbound-emails/triage/mark-summarized',
    entityType: 'email_triage',
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: result,
    statusCode: 200,
  });
  return success({ marked: result.marked });
}, { schema: markSummarizedSchema, permission: 'inbound_email.triage' });
