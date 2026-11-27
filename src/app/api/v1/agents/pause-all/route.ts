import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { forbidden } from '@/lib/api/errors';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { agentsPauseState, setAgentsPaused } from '@/lib/api/workspace-controls';
import { auditSettingsForKey } from '@/lib/api/workspace-settings';
import { agentsPauseSchema } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * The kill switch for every agent (Settings > Security, the Agents home), as
 * /api/workspace/agents-pause serves it to the app. While it is on, agents'
 * keys still read, beat and report telemetry; every other write answers 423
 * agents_paused. People's keys are never paused, so only an Owner's own key
 * (or connected AI tool) switches it, and can always switch it back off.
 * Any member but a guest reads it. Answers { paused_at, paused_by }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  if (access.role === 'guest') throw forbidden('Guests do not see the agents');
  return success(await agentsPauseState(supabase));
}, { permission: 'tasks.read' });

export const PUT = withApi<{ paused: boolean }>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'pauses or resumes every agent');
  const before = await agentsPauseState(supabase);
  const after = await setAgentsPaused(supabase, body.paused, teamMemberId);
  if (!!before.paused_at !== !!after.paused_at) {
    auditSettingsForKey(supabase, '/api/v1/agents/pause-all', { apiKeyId, teamMemberId },
      { method: 'PUT', entity_type: 'business_settings', request_body: body, before_snapshot: before, after_snapshot: after });
  }
  return success(after);
}, { permission: 'settings.manage', schema: agentsPauseSchema });
