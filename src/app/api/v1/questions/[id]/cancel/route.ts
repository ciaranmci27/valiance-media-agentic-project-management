import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { cancelQuestion } from '@/lib/api/questions';
import { cancelQuestionSchema } from '@/lib/questions';

/** Withdraws an open question: whoever asked it, the Owner, or a key with team.manage. 409 once it is closed. */
export const POST = withApi(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const { id } = params as { id: string };
  const question = await cancelQuestion({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, id);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/questions/${id}/cancel`, entityType: 'question', entityId: id, apiKeyId, teamMemberId, afterSnapshot: question, statusCode: 200 });
  return success(question);
}, { schema: cancelQuestionSchema, optionalBody: true, permission: ['tasks.read', 'questions.ask'] });
