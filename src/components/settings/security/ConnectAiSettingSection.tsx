'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { connectAiSettingRead } from '@/lib/reads';

/**
 * Settings > Security: "Let people connect AI tools" (Connect AI), on by
 * default. Off, nobody can sign an AI tool in, and tools already connected
 * get refused until it is on again; their connections are kept, so turning
 * it back on needs nobody to reconnect. Owners only.
 */
export function ConnectAiSettingSection() {
  const read = useRead(connectAiSettingRead);
  const [busy, setBusy] = useState(false);

  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await workspaceApi<{ ready: boolean; enabled: boolean; api_enabled: boolean }>('/api/workspace/connect-ai', { method: 'PUT', body: { enabled } });
      setReadData(connectAiSettingRead, () => next);
      invalidateTables(['business_settings']);
      toast('success', enabled ? 'People can connect AI tools' : 'Connecting AI tools is off');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="connect-ai-setting-heading">
      <SettingsSectionHeader
        icon={Sparkles}
        headingId="connect-ai-setting-heading"
        title="Connect AI"
        description="Each person can connect Claude, ChatGPT or another AI tool to their own work from Settings > Account. A tool signs in as them, can do only what they can, and never manages settings, people or keys."
      />
      {!read.data ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the switch.' : 'Loading'}</p>
      ) : !read.data.ready ? (
        <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-amber-100">
          This needs the latest database update. Apply it from Settings &gt; Updates, then come back here.
        </p>
      ) : (
        <Toggle
          checked={read.data.enabled}
          disabled={busy}
          onChange={(on) => void set(on)}
          label="Let people connect AI tools"
          description={read.data.enabled
            ? (read.data.api_enabled ? 'On: anyone with API access can connect their own tools.' : 'On, but API access is off for this workspace, so tools cannot connect yet.')
            : 'Off: tools cannot sign in, and connected ones are refused until you turn this on.'}
        />
      )}
    </section>
  );
}
