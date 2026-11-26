'use client';

import { PauseCircle } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { AGENTS_PAUSE_WHAT_STOPS, pausedLine, useAgentsPause } from '@/components/agent/AgentsPauseBanner';
import { isModuleEnabled } from '@/lib/access-control';
import { useAuth } from '@/lib/auth-context';

/**
 * Settings > Security, first card: the kill switch, for Owners whether or
 * not the Agents module is on (agent keys and people's assistants keep
 * working while it is off). On, every agent's key, personal assistants and
 * company chat agents included, still reads, reports its heartbeat and its
 * usage, and every other write is refused (423 agents_paused). People's own
 * keys and sessions are never paused.
 */
export function AgentsPauseSection() {
  const pause = useAgentsPause();
  const { access } = useAuth();
  const agentsOn = isModuleEnabled(access, 'agents');
  const paused = !!pause.state?.paused_at;
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="agents-pause-heading">
      <SettingsSectionHeader
        icon={PauseCircle}
        headingId="agents-pause-heading"
        title="Pause every agent"
        description={`${AGENTS_PAUSE_WHAT_STOPS} People's own sign-ins and API keys keep working.`}
      />
      {!agentsOn && (
        <p className="mb-4 rounded-lg bg-white/[0.04] px-3.5 py-3 text-sm text-zinc-300">
          AI agents are switched off in Workspace &gt; Features, but agent keys and personal assistants still work until they are revoked. This switch still stops them all.
        </p>
      )}
      {!pause.state ? (
        <p className="text-sm text-zinc-400" role="status">{pause.failed ? 'Could not load the switch.' : 'Loading'}</p>
      ) : (
        <Toggle
          checked={paused}
          disabled={pause.busy || !pause.canSwitch}
          onChange={(on) => (on ? pause.pause() : pause.resume())}
          label="Agents paused"
          description={paused ? pausedLine(pause.state) : 'Off: agents work as their rules and limits allow. Agents you paused one by one stay paused.'}
        />
      )}
      {pause.confirm}
    </section>
  );
}
