import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { decideTemplateDraft } from '@/lib/api/template-drafts';
import { decideTemplateDraftSchema, type DecideTemplateDraftInput } from '@/lib/task-templates';

/** A full-size playbook (200 tasks) is a few seconds; this is the ceiling, as for the MCP server. */
export const maxDuration = 60;

/**
 * Rejects a draft by deciding its approval, the same path as the approval card
 * in the app: only whom the approval names (or the Owner), never an agent,
 * a personal agent for its person included, and over the API only with
 * approvals.decide on the person's own key. It records the rejection.
 * Twice is 409 draft_decided. Answers { draft, run, template_changed_since }.
 *
 * Permission: tasks.create, on the draft's project.
 */
export const POST = withApi<DecideTemplateDraftInput, { draftId: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await decideTemplateDraft({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, params.draftId, 'reject', body?.note);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/task-templates/drafts/${params.draftId}/reject`, entityType: 'task_template_run_draft', entityId: params.draftId, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { status: result.draft.status, run_id: result.draft.run_id }, statusCode: 200 });
  return success(result);
}, { schema: decideTemplateDraftSchema, optionalBody: true, permission: 'tasks.create' });
