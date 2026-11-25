'use client';

import { useState } from 'react';
import { Loader2, Webhook } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { WEBHOOKS_DESCRIPTION } from '@/components/settings/WebhooksPanel';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { Button } from '@/components/ui/Button';
import { applyModuleChange } from '@/lib/modules/registry';

/**
 * Settings > Developers > Webhooks while the module is off, so the section
 * is always where people look for it: what webhooks do, and the way to turn
 * them on. An Owner turns the module on right here, with the same switch as
 * Settings > Workspace > Features; anyone else is told to ask an Owner.
 * Once it is on, the page shows the endpoints in its place.
 */
export function WebhooksOffCard({ canTurnOn }: { canTurnOn: boolean }) {
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="webhooks-heading">
      <SettingsSectionHeader icon={Webhook} title="Webhooks" headingId="webhooks-heading" description={WEBHOOKS_DESCRIPTION} />
      <div className="rounded-lg bg-white/[0.03] px-4 py-6 text-center">
        <Webhook className="mx-auto mb-2 text-zinc-400" size={22} aria-hidden="true" />
        <p className="text-sm font-medium text-zinc-200">Webhooks are off</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-zinc-400">
          Turn them on to add endpoints. Each one gets the events you pick, signed so your system knows they came from here.
        </p>
        {canTurnOn ? <TurnOn /> : (
          <p className="mt-4 text-sm text-zinc-300">Ask an Owner to turn on webhooks.</p>
        )}
      </div>
    </section>
  );
}

function TurnOn() {
  const { enabled, save, saving } = useModuleSwitch();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const turnOn = async () => {
    setOutcome(null);
    const result = await save(applyModuleChange(enabled, 'webhooks', true));
    // On: access refreshes and the endpoints take this card's place.
    if (!result.ok) setOutcome({ tone: 'error', text: `Not turned on. ${result.message}`, onRetry: () => { void turnOn(); } });
  };

  return (
    <div className="mt-4 flex flex-col items-center gap-3">
      <Button
        size="sm"
        onClick={() => { void turnOn(); }}
        disabled={saving}
        icon={saving ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}
      >
        {saving ? 'Turning on' : 'Turn on webhooks'}
      </Button>
      {outcome && <OutcomeLine outcome={outcome} busy={saving} />}
      <p className="text-[11px] text-zinc-400">You can turn it off again in Settings &gt; Workspace.</p>
    </div>
  );
}
