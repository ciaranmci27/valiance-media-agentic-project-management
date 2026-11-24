import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { listQuestions, questionFiltersFrom, requestApproval } from '@/lib/api/questions';
import { requestApprovalSchema, type RequestApprovalInput } from '@/lib/questions';

/**
 * Approvals the key's member can see: questions of kind approval, newest
 * first, with the same filters as GET /api/v1/questions (status, asked_by,
 * asked_to, task_id, project_id).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const filters = questionFiltersFrom(searchParams, teamMemberId);
  const { rows, total } = await listQuestions({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, { ...filters, kind: 'approval', offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: 'tasks.read' });

/**
 * Asks a person to approve an action before the caller does it: a question
 * with the choices approve and reject, on a task, a project or nothing.
 * asked_to defaults to the agent's escalation target, else the Owner, and
 * must be a person. Their bell rings; poll GET /api/v1/approvals/:id until
 * decision is approved or rejected. Expired or cancelled means no.
 */
export const POST = withApi(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const approval = await requestApproval({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, body as RequestApprovalInput);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/approvals', entityType: 'question', entityId: approval.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: approval, statusCode: 201 });
  return created(approval);
}, { schema: requestApprovalSchema, permission: 'tasks.read' });
