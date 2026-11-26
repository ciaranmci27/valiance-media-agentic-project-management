import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { draftTemplateRun } from '@/lib/api/template-drafts';
import { draftTemplateRunSchema, type DraftTemplateRunInput } from '@/lib/task-templates';

/**
 * Proposes a run of the template for a person to approve: what a run takes,
 * plus extra_steps (tasks it adds), removed_steps (template keys it leaves
 * out), note, asked_to or asked_to_group, expires_at and idempotency_key.
 * Checked like a run (every error with its path); role maps and added steps
 * are checked against the approver's rights when they decide. Asks for the
 * decision through an approval (question.created). Answers 201 with the
 * draft and its preview; the same idempotency_key answers the same draft
 * (200). The path for an agent whose new tasks need approval.
 *
 * Permission: tasks.create, on a project the key's member can open.
 */
export const POST = withApi<DraftTemplateRunInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { draft, replayed } = await draftTemplateRun(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  if (!replayed) {
    logAudit(supabase, { method: 'POST', endpoint: `/api/v1/task-templates/${params.id}/drafts`, entityType: 'task_template_run_draft', entityId: draft.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { id: draft.id, question_id: draft.question_id }, statusCode: 201 });
  }
  return success(draft, replayed ? 200 : 201);
}, { schema: draftTemplateRunSchema, optionalBody: true, permission: 'tasks.create' });
