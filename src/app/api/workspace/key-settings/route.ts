import { insertAuditRows } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { agentKeyLifetimeDays, setAgentKeyLifetimeDays } from '@/lib/api/key-lifetime';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { keySettingsSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * How long a new agent key lasts (agent_key_lifetime_days; null: until
 * revoked, the default). Keys made before keep their own expiry. Owner only.
 * Answers { agent_key_lifetime_days }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner sees key settings', { reason: 'owner_only' });
    return { agent_key_lifetime_days: await agentKeyLifetimeDays(service) };
  });
}

export async function PATCH(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes key settings', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, keySettingsSchema);
    const before = await agentKeyLifetimeDays(service);
    const days = await setAgentKeyLifetimeDays(service, body.agent_key_lifetime_days);
    const { error } = await insertAuditRows(service, {
      method: 'PATCH', endpoint: '/api/workspace/key-settings', entity_type: 'workspace_key_settings', team_member_id: memberId,
      before_snapshot: { agent_key_lifetime_days: before }, after_snapshot: { agent_key_lifetime_days: days }, status_code: 200, via: 'app',
    });
    if (error) console.error('[key-settings] audit write failed', error);
    return { agent_key_lifetime_days: days };
  });
}
