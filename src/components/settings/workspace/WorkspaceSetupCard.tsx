'use client';

import { useState } from 'react';
import { ArrowRight, LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { FEATURES_HREF } from '@/components/modules/ModuleGate';
import { MODULE_IDS, PRESETS, PRESET_IDS, type ModuleId, type PresetId } from '@/lib/modules/registry';
import { BrandSetupStep } from './BrandSetupStep';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { PresetCard } from './PresetCard';
import { useModuleSwitch } from './workspace-modules';

/**
 * First-run setup, at the top of the Dashboard: on a fresh install the Owner
 * picks a preset, goes to Features, or says Not now. Any of the three marks
 * setup done, so it is asked once. After a preset comes a light brand step
 * (name, logo, color), which Skip or Done leaves at the defaults. Only Owners read the setup state, and
 * never in the demo workspace (it has no database).
 */
export function WorkspaceSetupCard() {
  const { enabled, save, saving, read, isDemoMode, isOwner } = useModuleSwitch();
  const [busy, setBusy] = useState<PresetId | 'skip' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // After a preset the card stays as its receipt (with Undo) until Done or the next visit.
  const [receipt, setReceipt] = useState(false);
  const [closed, setClosed] = useState(false);

  if (!isOwner || isDemoMode || closed) return null;
  const needsSetup = read.data?.status === 'ready' && !read.data.setupCompleted;
  if (!needsSetup && !receipt) return null;

  const undoTo = (previous: ModuleId[]) => async () => {
    const result = await save(previous);
    setOutcome(result.ok
      ? { tone: 'done', text: 'Undone. Your previous features are back.' }
      : { tone: 'error', text: `Not saved, so nothing changed. ${result.message}` });
  };

  const pick = async (id: PresetId) => {
    if (saving) return;
    const previous = enabled;
    setBusy(id);
    const result = await save(MODULE_IDS.filter((mod) => PRESETS[id].modules.includes(mod)), { completeSetup: true });
    setBusy(null);
    if (!result.ok) {
      setOutcome({ tone: 'error', text: `Not saved, so nothing changed. ${result.message}` });
      return;
    }
    setReceipt(true);
    setOutcome({ tone: 'done', text: `Set up as ${PRESETS[id].label}. You can change this any time in Features.`, onUndo: undoTo(previous) });
  };

  const notNow = async () => {
    if (saving) return;
    setBusy('skip');
    const result = await save(enabled, { completeSetup: true });
    setBusy(null);
    if (!result.ok) {
      setOutcome({ tone: 'error', text: `Not saved. ${result.message}` });
      return;
    }
    setClosed(true);
    toast('info', 'You can choose features any time in Settings.');
  };

  return (
    <section aria-labelledby="workspace-setup-title" className="glass-card rounded-xl p-4 lg:p-5">
      <div className="flex items-start gap-3">
        <div className="hidden flex-shrink-0 rounded-lg bg-brand-500/15 p-2 sm:block">
          <LayoutGrid size={18} className="text-brand-300" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="workspace-setup-title" className="font-semibold text-white">
                {receipt ? 'Your workspace is set up' : 'Set up your workspace'}
              </h2>
              {!receipt && (
                <p className="mt-0.5 text-sm text-zinc-400">Pick the parts of the app your business uses. You can change this any time in Settings.</p>
              )}
            </div>
            {receipt ? (
              <Button variant="ghost" size="sm" onClick={() => setClosed(true)}>Done</Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={saving} onClick={notNow}>Not now</Button>
            )}
          </div>

          {!receipt && (
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {PRESET_IDS.map((id) => (
                <PresetCard key={id} id={id} compact busy={busy === id} disabled={saving} onPick={pick} />
              ))}
            </div>
          )}

          {outcome && <OutcomeLine outcome={outcome} busy={saving} className="mt-3" />}

          <div className="mt-3 -ml-2.5">
            <Button href={FEATURES_HREF} variant="ghost" size="sm">
              {receipt ? 'Open Features' : 'Choose features one by one'}
              <ArrowRight size={13} aria-hidden="true" />
            </Button>
          </div>

          {receipt && <BrandSetupStep onSkip={() => setClosed(true)} />}
        </div>
      </div>
    </section>
  );
}
