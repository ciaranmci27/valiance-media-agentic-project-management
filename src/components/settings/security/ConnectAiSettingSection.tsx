'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { connectAiSettingRead } from '@/lib/reads';

type Switch = 'api_enabled' | 'enabled';

const OFF_CONFIRM: Record<Switch, { title: string; message: string; label: string; done: string }> = {
  api_enabled: {
    title: 'Turn off keys and agents?',
    message: 'Every API key, every agent and every connected AI tool in this workspace is refused at once, until you turn it back on. Nothing is revoked or deleted.',
    label: 'Turn off',
    done: 'Keys, agents and AI tools are off',
  },
  enabled: {
    title: 'Stop people connecting AI tools?',
    message: 'Nobody can connect Claude, ChatGPT or another AI tool, and tools already connected are refused until you turn this back on. Their connections are kept.',
    label: 'Turn off',
    done: 'Connecting AI tools is off',
  },
};

/**
 * Settings > Security, Owners only: two workspace switches. "API access"
 * (on by default): off, every API key, agent and connected AI tool is
 * refused, nothing revoked. "Let people connect AI tools" (Connect AI, on
 * by default): off, nobody can sign an AI tool in, and tools already
 * connected get refused until it is on again; their connections are kept.
 * Turning either off asks first.
 */
export function ConnectAiSettingSection() {
  const read = useRead(connectAiSettingRead);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Switch | null>(null);

  const set = async (which: Switch, on: boolean) => {
    setBusy(true);
    try {
      const next = await workspaceApi<{ ready: boolean; enabled: boolean; api_enabled: boolean }>('/api/workspace/connect-ai', { method: 'PUT', body: { [which]: on } });
      setReadData(connectAiSettingRead, () => next);
      invalidateTables(['business_settings']);
      toast('success', on ? (which === 'api_enabled' ? 'Keys, agents and AI tools are on' : 'People can connect AI tools') : OFF_CONFIRM[which].done);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it. Try again.');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };
  // Turning something on acts at once; turning it off stops tools and keys for everyone, so it asks.
  const flip = (which: Switch, on: boolean) => (on ? void set(which, true) : setConfirming(which));

  const data = read.data;
  return (
    <section className="glass-card h-full rounded-xl p-4 lg:p-5" aria-labelledby="connect-ai-setting-heading">
      <SettingsSectionHeader
        icon={Sparkles}
        headingId="connect-ai-setting-heading"
        title="Agents and AI tools"
        description="Each person can connect Claude, ChatGPT or another AI tool to their own work from AI > Your assistant. A tool signs in as them, can do only what they can, and never manages settings, people or keys."
      />
      {!data ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the switches.' : 'Loading'}</p>
      ) : (
        <div className="space-y-4">
          <div id="api-access" className="scroll-mt-6">
            <Toggle
              checked={data.api_enabled}
              disabled={busy}
              onChange={(on) => flip('api_enabled', on)}
              label="Let keys, agents and AI tools in"
              description={data.api_enabled
                ? 'On: API keys, agents and connected AI tools work, each within what it may do.'
                : 'Off: every key, agent and connected AI tool is refused. Nothing is revoked; turn it on to let them back in.'}
            />
          </div>
          {!data.ready ? (
            <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-zinc-200">
              Connect AI needs the latest database update. Apply it from Settings &gt; Updates, then come back here.
            </p>
          ) : (
            <Toggle
              checked={data.enabled}
              disabled={busy}
              onChange={(on) => flip('enabled', on)}
              label="Let people connect AI tools"
              description={data.enabled
                ? (data.api_enabled ? 'On: anyone can connect their own tools.' : 'On, but tools cannot connect while keys and agents are off. Turn that on above.')
                : 'Off: tools cannot sign in, and connected ones are refused until you turn this on.'}
            />
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={!!confirming}
        onClose={() => setConfirming(null)}
        onConfirm={() => { if (confirming) void set(confirming, false); }}
        title={confirming ? OFF_CONFIRM[confirming].title : ''}
        message={confirming ? OFF_CONFIRM[confirming].message : ''}
        confirmLabel={confirming ? OFF_CONFIRM[confirming].label : 'Turn off'}
        variant="danger"
      />
    </section>
  );
}
