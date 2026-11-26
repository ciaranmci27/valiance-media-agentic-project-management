import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { expireDueQuestions, getApproval } from '@/lib/api/questions';

/**
 * One approval the key can see, with its decision once there is one. 404
 * when hidden, missing, or a plain question. Decide it with
 * POST /api/v1/questions/:id/answer (choice approve or reject, text a note).
 */
export const GET = withApi(async ({ supabase, params, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  await expireDueQuestions(supabase);
  return success(await getApproval({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, id));
}, { permission: ['tasks.read', 'questions.ask'] });
