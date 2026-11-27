import type { SupabaseClient } from '@supabase/supabase-js';
import { heartbeatStaleAfterSeconds } from '@/lib/agent-status';
import { AGENT_RUN_STALE_AFTER_SECONDS } from '@/lib/agent-runs';

/**
 * The workers behind one agent (a pool: many instances on one agent's key).
 * A worker names itself with instance_id on run start, heartbeats, usage and
 * fleet reports; pm.agent_instances keeps one row per worker that beat or
 * was reported (20261127002000_agent_runtime.sql).
 *
 * A worker is live while it has a running run (updated in the last two
 * hours) or its last beat is fresh (two missed beats plus a minute, the
 * same rule as the agent's own heartbeat). The agent's presence line reads
 * the count ("3 working now"). Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export interface LiveInstance {
  instance_id: string;
  /** A running run, or its last beat said working. */
  working: boolean;
  /** Its last beat or report; null when it is known only by a running run. */
  last_seen_at: string | null;
  running_runs: number;
  status_note: string | null;
}

export interface LiveInstances {
  /** Distinct live workers: with a running run or a fresh beat. */
  count: number;
  /** Of those, the ones working now. */
  working: number;
  instances: LiveInstance[];
}

const missing = (error: { code?: string } | null) => !!error && ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code ?? '');

/** Rows past a week are forgotten when the same agent next reports. */
const FORGET_AFTER_MS = 7 * 24 * 3600_000;

/** Records one worker's beat or report. A database before the update keeps nothing (and says nothing). */
export async function recordInstance(db: SupabaseClient, agentId: string, instance: {
  instance_id: string;
  working: boolean;
  turn_started_at?: string | null;
  status_note?: string | null;
  expected_interval_seconds?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from('agent_instances').upsert({
    agent_id: agentId,
    instance_id: instance.instance_id,
    working: instance.working,
    turn_started_at: instance.working ? instance.turn_started_at ?? now : null,
    status_note: instance.status_note ?? null,
    ...(instance.expected_interval_seconds !== undefined ? { expected_interval_seconds: instance.expected_interval_seconds } : {}),
    last_seen_at: now,
  }, { onConflict: 'agent_id,instance_id' });
  if (error) {
    if (missing(error)) return;
    throw error;
  }
  const { error: forgetError } = await db.from('agent_instances').delete()
    .eq('agent_id', agentId).lt('last_seen_at', new Date(Date.now() - FORGET_AFTER_MS).toISOString());
  if (forgetError && !missing(forgetError)) throw forgetError;
}

/** The live workers of many agents, in two reads. */
export async function liveInstancesOf(db: SupabaseClient, agentIds: string[]): Promise<Map<string, LiveInstances>> {
  const ids = [...new Set(agentIds.filter(Boolean))];
  const out = new Map<string, LiveInstances>(ids.map((id) => [id, { count: 0, working: 0, instances: [] }]));
  if (ids.length === 0) return out;
  const now = Date.now();
  const [beats, runs] = await Promise.all([
    db.from('agent_instances').select('agent_id, instance_id, working, last_seen_at, expected_interval_seconds, status_note').in('agent_id', ids)
      .gte('last_seen_at', new Date(now - 2 * 86_400_000 - 60_000).toISOString())
      .then(({ data, error }) => {
        if (missing(error)) return [] as Row[];
        if (error) throw error;
        return (data ?? []) as Row[];
      }),
    db.from('agent_runs').select('agent_id, instance_id').in('agent_id', ids).eq('status', 'running').not('instance_id', 'is', null)
      .gte('updated_at', new Date(now - AGENT_RUN_STALE_AFTER_SECONDS * 1000).toISOString())
      .then(({ data, error }) => {
        if (missing(error)) return [] as Row[];
        if (error) throw error;
        return (data ?? []) as Row[];
      }),
  ]);
  const byAgent = new Map<string, Map<string, LiveInstance>>();
  const entry = (agentId: string, instanceId: string) => {
    const agent = byAgent.get(agentId) ?? new Map<string, LiveInstance>();
    byAgent.set(agentId, agent);
    const found = agent.get(instanceId) ?? { instance_id: instanceId, working: false, last_seen_at: null, running_runs: 0, status_note: null };
    agent.set(instanceId, found);
    return found;
  };
  for (const beat of beats) {
    const fresh = now - Date.parse(beat.last_seen_at) <= heartbeatStaleAfterSeconds(beat.expected_interval_seconds) * 1000;
    if (!fresh) continue;
    const live = entry(beat.agent_id, beat.instance_id);
    live.last_seen_at = beat.last_seen_at;
    live.status_note = beat.status_note ?? null;
    if (beat.working) live.working = true;
  }
  for (const run of runs) {
    const live = entry(run.agent_id, run.instance_id);
    live.running_runs += 1;
    live.working = true;
  }
  for (const [agentId, instances] of byAgent) {
    const list = [...instances.values()].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    out.set(agentId, { count: list.length, working: list.filter((i) => i.working).length, instances: list });
  }
  return out;
}

/** One agent's live workers. */
export async function liveInstances(db: SupabaseClient, agentId: string): Promise<LiveInstances> {
  return (await liveInstancesOf(db, [agentId])).get(agentId) ?? { count: 0, working: 0, instances: [] };
}
