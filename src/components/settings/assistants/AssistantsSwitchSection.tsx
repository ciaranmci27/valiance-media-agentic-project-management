'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { assistantSettingsRead } from '@/lib/reads';
import { ASSISTANT_DEFAULT_LABEL, ASSISTANT_LABEL_MAX } from '@/lib/assistant';

/**
 * Settings > Assistants, first card: assistants on or off for everyone, and
 * what the workspace calls them (the sidebar entry and the page title).
 * Assistants run on AI agents, so with that switched off this says where to
 * turn it on instead.
 */
export function AssistantsSwitchSection({ agentsOn }: { agentsOn: boolean }) {
  const read = useRead(assistantSettingsRead);
  const settings = read.data;
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setLabel(settings?.custom_label ?? ''), [settings?.custom_label]);

  const save = async (patch: { enabled?: boolean; label?: string | null }, done: string) => {
    setBusy(true);
    try {
      const next = await workspaceApi<{ enabled: boolean; label: string; custom_label: string | null }>('/api/workspace/assistants/settings', { method: 'PATCH', body: patch });
      setReadData(assistantSettingsRead, () => next);
      invalidateTables(['business_settings']);
      toast('success', done);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const labelChanged = (label.trim() || null) !== (settings?.custom_label ?? null);

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="assistants-heading">
      <SettingsSectionHeader
        icon={Sparkles}
        headingId="assistants-heading"
        title="Assistants"
        description="Everyone gets their own assistant: it sorts their inbox, keeps their tasks and reminders moving, and answers them in chat. People set theirs up on their own page."
      />
      {!agentsOn ? (
        <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
          Assistants run on AI agents, which are off. Turn on AI agents in{' '}
          <Link href="/settings/workspace#features" className="text-brand-300 underline-offset-2 hover:underline">Settings &gt; Workspace</Link> first.
        </p>
      ) : !settings ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the setting.' : 'Loading'}</p>
      ) : (
        <div className="space-y-5">
          <Toggle
            checked={settings.enabled}
            disabled={busy}
            onChange={(enabled) => void save({ enabled }, enabled ? 'Assistants are on' : 'Assistants are off')}
            label="Turn on assistants"
            description={settings.enabled ? 'People with an assistant see it in their sidebar.' : 'Off: nobody sees an assistant, and chat messages get a short "not turned on yet" answer.'}
          />
          <form
            className="max-w-md"
            onSubmit={(event) => {
              event.preventDefault();
              if (labelChanged) void save({ label: label.trim() || null }, 'Name saved');
            }}
          >
            <TextInput
              label="What you call them"
              description="Shown in the sidebar and on each person's page."
              placeholder={ASSISTANT_DEFAULT_LABEL}
              value={label}
              onChange={setLabel}
              maxLength={ASSISTANT_LABEL_MAX}
            />
            {labelChanged && (
              <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>Save name</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLabel(settings.custom_label ?? '')}>Cancel</Button>
              </div>
            )}
          </form>
        </div>
      )}
    </section>
  );
}
