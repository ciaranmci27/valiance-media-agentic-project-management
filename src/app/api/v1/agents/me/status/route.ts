import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { loadAgentStatus } from '@/lib/api/agent-status';

export const dynamic = 'force-dynamic';

/**
 * May the calling agent start work now? Check it before each turn: paused
 * (the workspace pause, or the agent's own), the budget this period (spend
 * by the shared rule, the caps, exceeded) and its limits. Skip the turn when
 * can_start_work is false; on a network error, go ahead (fail open). Pause
 * and budget only refuse calls into this app, so an agent that works in
 * another system needs this to stop there too. Never cached.
 *
 * Permission: any API scope the key carries and its member holds, so a key
 * with only agent_activity.write reads it. A paused agent reads it too.
 */
export const GET = withApi(async ({ supabase, teamMemberId }) => {
  const response = success(await loadAgentStatus(supabase, teamMemberId));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
