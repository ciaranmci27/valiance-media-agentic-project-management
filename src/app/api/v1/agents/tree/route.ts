import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { agentTree } from '@/lib/api/agent-hierarchy';

/**
 * The chart of company agents: every one with its orchestrator, depth, the agents
 * under it, reachable_directly, ask_first and who can use it in words. Top
 * orchestrators first, each followed by the agents under it. Personal assistants are
 * left out (they work only for their person).
 *
 * Permission: team.read, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access, scopes, teamMemberId }) => {
  return success(await agentTree(supabase, { memberId: teamMemberId, access, scopes }));
}, { permission: 'team.read' });
