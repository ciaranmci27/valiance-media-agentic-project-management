import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { exportRegistries } from '@/lib/api/agent-registries';

export const dynamic = 'force-dynamic';

/**
 * An Owner's own agent profiles and templates (live rows) as one versioned
 * document (format pm-agent-registries), for POST
 * /api/v1/agent-registries/import here or in another workspace. Code's ship
 * with the code and are left out.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, access }) => {
  requireAgentsEnabled(access);
  return success(await exportRegistries(supabase));
}, { permission: 'team.manage' });
