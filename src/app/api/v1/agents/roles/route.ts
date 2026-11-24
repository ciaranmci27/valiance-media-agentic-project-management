import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { agentRoles } from '@/lib/api/agent-workspace';

/**
 * The role labels agents carry, most used first: { roles, counts }.
 *
 * Permission: team.read (or team.manage), with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access }) => {
  requireAgentsEnabled(access);
  return success(await agentRoles(supabase));
}, { permission: 'team.read' });
