import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { expireDueQuestions, getQuestion } from '@/lib/api/questions';

/** One question the key can see, with its answer once there is one. 404 when hidden or missing. */
export const GET = withApi(async ({ supabase, params, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  await expireDueQuestions(supabase);
  return success(await getQuestion({ db: supabase, access, memberId: teamMemberId, channel: 'api', scopes }, id));
}, { permission: 'tasks.read' });
