import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { answerQuestion } from '@/lib/api/questions';
import { answerQuestionSchema, type AnswerQuestionInput } from '@/lib/questions';

/**
 * Answers a question with a choice, text, or both. Only the member asked,
 * the Owner, or a key whose member may manage the team (team.manage). 409
 * when it is already answered, cancelled or expired.
 */
export const POST = withApi(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { id } = params as { id: string };
  const question = await answerQuestion({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, id, body as AnswerQuestionInput);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/questions/${id}/answer`, entityType: 'question', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: question, statusCode: 200 });
  return success(question);
}, { schema: answerQuestionSchema, permission: 'tasks.read' });
