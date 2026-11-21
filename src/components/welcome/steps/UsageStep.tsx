'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import {
  MODULE_GROUPS,
  MODULE_IDS,
  MODULES,
  PRESETS,
  PRESET_IDS,
  applyModuleChange,
  dependentsOf,
  presetFor,
  requirementsOf,
  type ModuleId,
  type PresetId,
} from '@/lib/modules/registry';
import { ModuleRow } from '@/components/settings/workspace/ModuleRow';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { PresetCard } from '@/components/settings/workspace/PresetCard';
import { moduleList, useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { saveSidebarProjects } from '@/components/settings/workspace/brand-settings';
import { StepFrame, type WizardStepProps } from '../StepFrame';

/**
 * Step 2: which parts of the app the business uses. A preset sets them all;
 * the switches below fine-tune, keeping dependencies whole and saying so in
 * place ("Client invoicing needs Time, so Time is on too"). Nothing saves
 * until Continue, so trying things here is free.
 */
export function UsageStep({ onNext, onSkip, onBack }: WizardStepProps) {
  const { enabled, save, saving } = useModuleSwitch();
  const router = useRouter();
  const [selection, setSelection] = useState<ModuleId[] | null>(null);
  const [note, setNote] = useState<{ id: ModuleId; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = selection ?? enabled;
  const on = new Set(chosen);
  const current = presetFor(chosen);
  const changed = chosen.length !== enabled.length || chosen.some((id) => !enabled.includes(id));

  const pickPreset = (id: PresetId) => {
    setSelection(MODULE_IDS.filter((mod) => PRESETS[id].modules.includes(mod)));
    setNote(null);
  };

  const toggle = (id: ModuleId, next: boolean) => {
    const label = MODULES[id].label;
    if (next) {
      const alsoOn = requirementsOf(id).filter((mod) => !on.has(mod));
      setNote(alsoOn.length ? { id, text: `${label} needs ${moduleList(alsoOn)}, so ${alsoOn.length > 1 ? 'they are' : 'it is'} on too.` } : null);
    } else {
      const alsoOff = dependentsOf(id).filter((mod) => on.has(mod));
      setNote(alsoOff.length ? { id, text: `${moduleList(alsoOff)} ${alsoOff.length > 1 ? 'need' : 'needs'} ${label}, so ${alsoOff.length > 1 ? 'they are' : 'it is'} off too.` } : null);
    }
    setSelection(applyModuleChange(chosen, id, next));
  };

  const submit = async () => {
    if (!changed) {
      onNext();
      return;
    }
    setError(null);
    const result = await save(chosen);
    if (!result.ok) {
      setError(`Not saved, so nothing changed. ${result.message}`);
      return;
    }
    // The preset also sets how the sidebar lists projects: an agency's many
    // client projects as a list, a team's or a solo business's few as a menu.
    // A custom mix keeps what is set. Best effort: Brand settings can change it.
    const preset = presetFor(chosen);
    if (preset) {
      const style = await saveSidebarProjects(preset === 'agency' ? 'list' : 'menu');
      if (style.ok) router.refresh();
    }
    onNext();
  };

  return (
    <StepFrame
      title="How will you use it?"
      description="Pick the closest fit, then switch parts on or off. Anything off is hidden for everyone and can be turned on later in Settings > Features."
      onSubmit={() => { void submit(); }}
      onBack={onBack}
      onSkip={onSkip}
      busy={saving}
      error={error}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PRESET_IDS.map((id) => (
          <PresetCard key={id} id={id} current={current === id} disabled={saving} onPick={pickPreset} />
        ))}
      </div>
      {!current && <p className="mt-2 text-[11px] text-zinc-400">Custom mix</p>}

      <div className="mt-10">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Fine-tune</h2>
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
          <Lock size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
          Projects, tasks, team, notifications, reminders, files and API keys are always on.
        </p>
        <div className="mt-6 space-y-7">
          {MODULE_GROUPS.map((group) => {
            const ids = MODULE_IDS.filter((id) => MODULES[id].group === group.id);
            if (ids.length === 0) return null;
            const headingId = `welcome-group-${group.id}`;
            return (
              <div key={group.id} role="group" aria-labelledby={headingId}>
                <h3 id={headingId} className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{group.label}</h3>
                <ul className="divide-y divide-white/[0.06]">
                  {ids.map((id) => (
                    <ModuleRow key={id} id={id} on={on.has(id)} disabled={saving} onToggle={toggle}>
                      {note?.id === id ? <OutcomeLine outcome={{ tone: 'done', text: note.text }} /> : null}
                    </ModuleRow>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </StepFrame>
  );
}
