import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { askQuestion, listQuestions, questionFiltersFrom } from '@/lib/api/questions';
import { askQuestionSchema, type AskQuestionInput } from '@/lib/questions';

/**
 * Questions the key's member can see: ones it asked, ones it was asked, and
 * ones on tasks and projects it can open. Newest first. Filters: status
 * (open | answered | cancelled | expired | all, default all), asked_by and
 * asked_to (me or a member id), task_id, project_id.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const filters = questionFiltersFrom(searchParams, teamMemberId);
  const { rows, total } = await listQuestions({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, { ...filters, offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.read', 'questions.ask'] });

/**
 * Asks a question, on a task, a project or nothing. asked_to defaults to the
 * agent's escalation target, else the Owner. Their bell rings; poll
 * GET /api/v1/questions/:id for the answer.
 *
 * Permission: tasks.read, or questions.ask for a question that names no
 * task or project (403 place_needs_tasks_read otherwise). The same rule
 * reads them back: a questions.ask key sees only its own on nothing.
 */
export const POST = withApi(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const question = await askQuestion({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, body as AskQuestionInput);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/questions', entityType: 'question', entityId: question.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: question, statusCode: 201 });
  return created(question);
}, { schema: askQuestionSchema, permission: ['tasks.read', 'questions.ask'] });
