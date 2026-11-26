'use client';

import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { keyLifetimeChoice, keyLifetimeDays, keyLifetimeSettingOptions } from '@/lib/developers-settings';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { agentKeyLifetimeRead, personalKeyLifetimeRead } from '@/lib/reads';

/**
 * Settings > Developers (Owners only): how long new keys last. People's keys
 * start on the personal lifetime, and agent keys get the agent lifetime; for
 * anyone but an Owner each is also the longest a new key may last. Keys made
 * before keep their own expiry. The agent lifetime shows while AI agents is on.
 */
export function KeyLifetimeSection({ agentsOn }: { agentsOn: boolean }) {
  const personalRead = useRead(personalKeyLifetimeRead);
  const agentRead = useRead(agentKeyLifetimeRead);
  const personalDays = personalRead.data?.personal_key_lifetime_days;
  const agentDays = agentRead.data?.agent_key_lifetime_days;
  const [personal, setPersonal] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (personalDays !== undefined) setPersonal(keyLifetimeChoice(personalDays)); }, [personalDays]);
  useEffect(() => { if (agentDays !== undefined) setAgent(keyLifetimeChoice(agentDays)); }, [agentDays]);

  const loaded = personal !== null && (!agentsOn || agent !== null);
  const personalChanged = personal !== null && personalDays !== undefined && personal !== keyLifetimeChoice(personalDays);
  const agentChanged = agentsOn && agent !== null && agentDays !== undefined && agent !== keyLifetimeChoice(agentDays);
  const failed = (personalRead.failed && !personalRead.data) || (agentsOn && agentRead.failed && !agentRead.data);

  const discard = () => {
    if (personalDays !== undefined) setPersonal(keyLifetimeChoice(personalDays));
    if (agentDays !== undefined) setAgent(keyLifetimeChoice(agentDays));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (personalChanged) {
        const next = await workspaceApi<{ personal_key_lifetime_days: number | null }>('/api/workspace/key-settings/personal', {
          method: 'PATCH', body: { personal_key_lifetime_days: keyLifetimeDays(personal!) },
        });
        setReadData(personalKeyLifetimeRead, () => next);
      }
      if (agentChanged) {
        const next = await workspaceApi<{ agent_key_lifetime_days: number | null }>('/api/workspace/key-settings', {
          method: 'PATCH', body: { agent_key_lifetime_days: keyLifetimeDays(agent!) },
        });
        setReadData(agentKeyLifetimeRead, () => next);
      }
      invalidateTables(['business_settings', 'api_audit_log']);
      toast('success', 'Key lifetimes saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="key-lifetimes" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6" aria-labelledby="key-lifetimes-heading">
      <SettingsSectionHeader
        icon={Timer}
        headingId="key-lifetimes-heading"
        title="Key lifetimes"
        description="How long new API keys last before they stop working. Keys made before keep their own expiry."
      />
      {!loaded ? (
        <p className="text-sm text-zinc-400" role="status">{failed ? 'Could not load the settings.' : 'Loading'}</p>
      ) : (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Select
            label="People's keys"
            value={personal!}
            onChange={setPersonal}
            options={keyLifetimeSettingOptions(personalDays ?? null)}
            helperText="New keys start here, and a rotated key keeps its own length within it. Only an Owner can make one that lasts longer."
          />
          {agentsOn && (
            <Select
              label="AI agent keys"
              value={agent!}
              onChange={setAgent}
              options={keyLifetimeSettingOptions(agentDays ?? null)}
              helperText="Every new agent key lasts this long, and so does each key a rotation makes. Rotate before it ends to keep the agent connected."
            />
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            {(personalChanged || agentChanged) && <Button variant="ghost" onClick={discard}>Discard</Button>}
            <Button onClick={save} disabled={!(personalChanged || agentChanged) || busy}>{busy ? 'Saving' : 'Save'}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
