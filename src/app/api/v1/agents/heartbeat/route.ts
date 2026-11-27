import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { agentHeartbeatSchema, type AgentHeartbeat } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { heartbeatStaleAfterSeconds } from '@/lib/agent-status';
import { liveInstances, recordInstance } from '@/lib/api/agent-instances';

/**
 * An agent's own heartbeat, for any harness: a container fleet, a cron job,
 * a desktop agent. It writes the key's own agent_health row, the same row a
 * fleet publisher writes, so every status view reads one authority.
 *
 * A self-report means the agent is up: container_running is true (there may
 * be no container at all), working says whether a turn is running, and the
 * expected interval stays as last declared when a beat leaves it out.
 * Readers call the row stale after two missed beats plus a minute, so an
 * agent that beats hourly does not read as offline between runs.
 *
 * When a fleet publisher reports this agent (its row has a container), the
 * publisher's facts win and its beat stays the only proof of liveness: the
 * self-report writes only status_note (reported_at does not move) and
 * answers publisher_reports: true.
 *
 * A worker of a pool sends instance_id: its own beat is kept on its own
 * (pm.agent_instances), and the agent reads working while any live worker
 * is; the answer carries live_instances (count and working).
 *
 * Permission: any agent key that may log its activity or read tasks. It
 * reports only itself (another member_id is refused); agents.manage stays
 * the publisher's, on /api/v1/agents/health.
 */
export const POST = withApi<AgentHeartbeat>(async ({ supabase, body, access, teamMemberId }) => {
  requireAgentsEnabled(access);
  if (body.member_id && body.member_id !== teamMemberId) {
    throw forbidden('An agent reports only its own heartbeat', {
      reason: 'own_heartbeat_only',
      hint: 'Leave member_id out: the key decides whose heartbeat it is. A fleet publisher reports others on POST /api/v1/agents/health with agents.manage.',
    });
  }
  if (access.role !== 'agent') {
    throw forbidden('Only agent team members report a heartbeat', { reason: 'agents_only' });
  }

  const now = new Date().toISOString();
  const { data: previous, error: previousError } = await supabase
    .from('agent_health')
    .select('container, turn_running, turn_started_at')
    .eq('member_id', teamMemberId)
    .maybeSingle();
  if (previousError) throw previousError;

  // A row with a container is a fleet publisher's: its container, turn,
  // interval and reported_at are the publisher's facts, from the host. The
  // agent's own beat writes only its note, so a dead publisher still reads
  // offline after its three minutes while the agent keeps beating, and a beat
  // never clears a turn the host sees running.
  const publisherRow = !!previous?.container;
  // A worker's own beat is kept on its own; the agent works while any live worker does.
  let pool: { count: number; working: number } | null = null;
  if (body.instance_id) {
    await recordInstance(supabase, teamMemberId, {
      instance_id: body.instance_id, working: body.working ?? false, turn_started_at: body.turn_started_at ?? null,
      status_note: body.status_note ?? null, expected_interval_seconds: body.expected_interval_seconds,
    });
    const live = await liveInstances(supabase, teamMemberId);
    pool = { count: live.count, working: live.working };
  }
  let row: Record<string, unknown>;
  if (publisherRow) {
    row = { member_id: teamMemberId, status_note: body.status_note ?? null };
  } else {
    const working = (body.working ?? false) || (pool !== null && pool.working > 0);
    let turnStartedAt: string | null = null;
    if (working) {
      // A turn still running since the last beat keeps when it began.
      turnStartedAt = body.turn_started_at
        ?? (previous?.turn_running && previous.turn_started_at ? previous.turn_started_at : now);
    }
    row = {
      member_id: teamMemberId,
      container_running: true,
      turn_running: working,
      turn_started_at: turnStartedAt,
      reported_at: now,
      status_note: body.status_note ?? null,
      ...(body.expected_interval_seconds !== undefined ? { expected_interval_seconds: body.expected_interval_seconds } : {}),
    };
  }

  // Columns left out keep their value on an existing row (container, and the
  // interval when not declared) and take their default on a new one.
  const { data, error } = await supabase
    .from('agent_health')
    .upsert(row, { onConflict: 'member_id' })
    .select('member_id, turn_running, turn_started_at, reported_at, expected_interval_seconds, status_note')
    .single();
  if (error) throw error;

  return success({
    member_id: data.member_id,
    working: data.turn_running,
    turn_started_at: data.turn_started_at,
    reported_at: data.reported_at,
    expected_interval_seconds: data.expected_interval_seconds,
    stale_after_seconds: heartbeatStaleAfterSeconds(data.expected_interval_seconds),
    status_note: data.status_note,
    // True when a fleet publisher reports this agent: working, its turn and
    // the interval and reported_at stay the publisher's; only the note
    // came from this beat.
    publisher_reports: publisherRow,
    // A worker's beat: which one, and how many of the agent's workers are live and working.
    ...(body.instance_id ? { instance_id: body.instance_id, live_instances: pool } : {}),
  });
}, { schema: agentHeartbeatSchema, optionalBody: true, permission: ['agent_activity.write', 'tasks.read'] });
