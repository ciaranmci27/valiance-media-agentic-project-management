'use client';

import { PauseCircle } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { pausedLine, useAgentsPause } from '@/components/agent/AgentsPauseBanner';

/**
 * Settings > Security, first card: the kill switch. On, every agent's key
 * still reads, reports its heartbeat and its usage, and every other write is
 * refused (423 agents_paused). People's keys and sessions are never paused.
 */
export function AgentsPauseSection() {
  const pause = useAgentsPause();
  const paused = !!pause.state?.paused_at;
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="agents-pause-heading">
      <SettingsSectionHeader
        icon={PauseCircle}
        headingId="agents-pause-heading"
        title="Pause every agent"
        description="Stops every agent at once. They keep reading and reporting their heartbeat and usage, so you can still watch them; every other change they try is refused. People are not affected."
      />
      {!pause.state ? (
        <p className="text-sm text-zinc-400" role="status">{pause.failed ? 'Could not load the switch.' : 'Loading'}</p>
      ) : (
        <Toggle
          checked={paused}
          disabled={pause.busy || !pause.canSwitch}
          onChange={(on) => (on ? pause.pause() : pause.resume())}
          label="Agents paused"
          description={paused ? pausedLine(pause.state) : 'Off: agents work as their rules and limits allow.'}
        />
      )}
      {pause.confirm}
    </section>
  );
}
