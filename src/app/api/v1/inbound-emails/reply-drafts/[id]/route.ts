import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { assertUuid, memberInboxIds } from '@/lib/communications/agent-access';
import { DRAFT_COLUMNS } from '@/lib/communications/inbox-drafts';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

const draftResultSchema = z.object({
  body: z.string().trim().min(1).max(20_000).optional(),
  failure: z.string().trim().min(1).max(500).optional(),
}).strict().refine((value) => (value.body === undefined) !== (value.failure === undefined), { message: 'Send the draft as body, or why there is none as failure' });
type DraftResult = z.infer<typeof draftResultSchema>;

/**
 * The agent answers a draft request: the reply text (body), or why it could
 * not write one (failure). Only a waiting request takes an answer (409
 * otherwise). The person copies the draft into their own mail; nothing is
 * sent.
 */
export const PUT = withApi<DraftResult, { id: string }>(async ({ supabase, params, body, teamMemberId, apiKeyId, access }) => {
  const id = assertUuid(params.id, 'id');
  const { data: draft, error } = await comms(supabase).from('reply_drafts').select(DRAFT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  const { data: message, error: messageError } = draft
    ? await comms(supabase).from('messages').select('inbox_id').eq('id', draft.message_id).maybeSingle()
    : { data: null, error: null };
  if (messageError) throw messageError;
  // A draft in an inbox the key cannot read is 404, like one that does not exist.
  const granted = await memberInboxIds(supabase, teamMemberId, access);
  if (!draft || !message || !granted.includes(message.inbox_id)) throw notFound('Reply draft');
  if (draft.status !== 'requested') {
    throw new ApiError(409, 'CONFLICT', 'This draft request is already answered', { reason: 'draft_answered', status: draft.status });
  }
  const { data: updated, error: updateError } = await comms(supabase).from('reply_drafts').update({
    status: body.body !== undefined ? 'ready' : 'failed',
    body: body.body ?? null,
    failure: body.failure ?? null,
    drafted_by: teamMemberId,
    completed_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'requested').select(DRAFT_COLUMNS).maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new ApiError(409, 'CONFLICT', 'This draft request is already answered', { reason: 'draft_answered' });
  logAudit(supabase, {
    method: 'PUT',
    endpoint: `/api/v1/inbound-emails/reply-drafts/${id}`,
    entityType: 'email_reply_draft',
    entityId: id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: updated,
    statusCode: 200,
  });
  return success(updated);
}, { schema: draftResultSchema, permission: 'inbound_email.triage' });
