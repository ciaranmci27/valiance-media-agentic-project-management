'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
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
export function useAgentHealth(): Record<string, AgentHealth> {
  const [health, setHealth] = useState<Record<string, AgentHealth>>({});

  useEffect(() => {
    const supabase = createClient();
    let dead = false;

    (async () => {
      const { data, error } = await supabase
        .from('agent_health')
        .select('member_id, container_running, turn_running, turn_started_at, reported_at');
      if (dead || error || !data) return;
      setHealth(Object.fromEntries((data as HealthRow[]).map((r) => [r.member_id, toHealth(r)])));
    })();

    const channel = supabase
      .channel('agent-health')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_health' }, (p) => {
        const row = p.new as HealthRow;
        if (!row?.member_id) return;
        setHealth((h) => ({ ...h, [row.member_id]: toHealth(row) }));
      })
      .subscribe();

    return () => {
      dead = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return health;
}
