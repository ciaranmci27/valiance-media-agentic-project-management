'use client';

import { createClient } from '@/lib/supabase/client';
import { useRead, type Read } from '@/lib/query-cache';
import type { AgentHealth } from '@/lib/agent-status';

type HealthRow = {
  member_id: string;
  container_running: boolean;
  turn_running: boolean;
  turn_started_at: string | null;
  reported_at: string;
};

const toHealth = (r: HealthRow): AgentHealth => ({
  containerRunning: r.container_running,
  turnRunning: r.turn_running,
  turnStartedAt: r.turn_started_at ? new Date(r.turn_started_at).getTime() : null,
  reportedAt: new Date(r.reported_at).getTime(),
});

/**
 * Live agent_health rows keyed by member id, shared by the fleet strip and
 * the 3D scene so both read the same authority.
 *
 * Returns {} until rows arrive, and permanently {} where the table does not
 * exist yet: consumers treat a missing entry as "no feed" and fall back to
 * the phrase heuristics, so this hook failing soft is part of the contract
 * rather than an error path.
 *
 * Staleness is deliberately NOT computed here. Rows carry reportedAt and
 * deriveStatus judges freshness against its own clock, so a feed that stops
 * dead still goes red even though no new row ever arrives to re-render this
 * hook: the consumers' ticking clocks re-derive with the old row and cross
 * the threshold on their own.
 */
// One cached read for every consumer (query-cache): the store's live sync
// marks it stale on each agent_health change and it re-reads (a few rows),
// instead of each consumer opening its own realtime channel.
const agentHealthRead: Read<Record<string, AgentHealth>> = {
  key: 'agent-health',
  tables: ['agent_health'],
  ttlMs: 60_000,
  load: async () => {
    const { data, error } = await createClient()
      .from('agent_health')
      .select('member_id, container_running, turn_running, turn_started_at, reported_at');
    if (error) throw error;
    return Object.fromEntries(((data ?? []) as HealthRow[]).map((r) => [r.member_id, toHealth(r)]));
  },
};

const NO_HEALTH: Record<string, AgentHealth> = {};

export function useAgentHealth(): Record<string, AgentHealth> {
  return useRead(agentHealthRead).data ?? NO_HEALTH;
}
