import { forbidden } from '@/lib/api/errors';
import { agentsPauseState, setAgentsPaused } from '@/lib/api/workspace-controls';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { agentsPauseSchema } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * The kill switch for every agent (business_settings.agents_paused_at).
 * While it is on, agents' keys still read, beat and report telemetry; every
 * other write answers 423 agents_paused. People's keys and sessions are never
 * paused. Any member but a guest reads it (the Agents home says so); only an
 * Owner flips it, written as them so the audit log records who.
 * Answers { paused_at, paused_by }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role === 'guest') throw forbidden('Guests do not see the agents');
    return agentsPauseState(service);
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner pauses or resumes every agent', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, agentsPauseSchema);
    return setAgentsPaused(service, body.paused, memberId);
  }, { noStore: true });
}
