'use client';

import { useRef, useState } from 'react';
import { Database, Eye, LayoutGrid, Lock, RotateCw } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
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
import { ModuleRow, TurnOffQuestion } from './ModuleRow';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { PresetCard } from './PresetCard';
import { moduleList, useModuleSwitch } from './workspace-modules';

const DESCRIPTION = 'Choose the parts of the app your business uses. Turning one off hides it for everyone. Nothing is deleted, and turning it back on brings everything back.';

/** Where the last change's line shows: under the presets, or under the module it came from. */
type Anchor = 'presets' | ModuleId;

/**
 * Settings > Features: the Owner picks the parts of the app the workspace
 * uses, from a preset or one by one. Every change applies at once and leaves
 * one line with Undo where it was made; a switch that would take other
 * modules with it says so in place first.
 */
export function FeaturesSection() {
  const { enabled, save, saving, read, isDemoMode } = useModuleSwitch();
  const [outcome, setOutcome] = useState<(Outcome & { anchor: Anchor }) | null>(null);
  const [askingOff, setAskingOff] = useState<ModuleId | null>(null);
  const toggles = useRef(new Map<ModuleId, HTMLButtonElement>());
  // Each change gets a number, so a slow save never overwrites the line of a newer one.
  const changeCount = useRef(0);

  const migration = read.data?.status === 'migration' ? read.data.message : null;
  // An Owner choosing features here has set the workspace up: the setup wizard stops showing.
  const finishesSetup = read.data?.status === 'ready' && !read.data.setupCompleted;
  const on = new Set(enabled);
  const current = presetFor(enabled);

  const commit = async (next: ModuleId[], anchor: Anchor, text: string, previous: ModuleId[] | null) => {
    const change = ++changeCount.current;
    setAskingOff(null);
    const undo = previous ? () => { void commit(previous, anchor, 'Undone. Your previous features are back.', null); } : undefined;
    setOutcome({ anchor, tone: 'done', text, onUndo: undo });
    const result = await save(next, { completeSetup: finishesSetup });
    if (result.ok || change !== changeCount.current) return;
    // The database is not ready: the panel at the top says so, once.
    if (result.migration) {
      setOutcome(null);
      return;
    }
    setOutcome({
      anchor,
      tone: 'error',
      text: `Not saved, so nothing changed. ${result.message}`,
      onRetry: () => { void commit(next, anchor, text, previous); },
    });
  };

  const turnOff = (id: ModuleId) => {
    const label = MODULES[id].label;
    const alsoOff = dependentsOf(id).filter((mod) => on.has(mod));
    const text = alsoOff.length
      ? `${label} is off, and so ${alsoOff.length > 1 ? 'are' : 'is'} ${moduleList(alsoOff)}. Nothing was deleted.`
      : `${label} is off. Nothing was deleted.`;
    void commit(applyModuleChange(enabled, id, false), id, text, enabled);
  };

  const onToggle = (id: ModuleId, next: boolean) => {
    if (saving || migration) return;
    const label = MODULES[id].label;
    if (next) {
      const alsoOn = requirementsOf(id).filter((mod) => !on.has(mod));
      const text = alsoOn.length
        ? `${label} is on. ${moduleList(alsoOn)} ${alsoOn.length > 1 ? 'were' : 'was'} turned on too, since ${label} needs ${alsoOn.length > 1 ? 'them' : 'it'}.`
        : `${label} is on.`;
      void commit(applyModuleChange(enabled, id, true), id, text, enabled);
      return;
    }
    // Others need this one: say what else goes before anything changes.
    if (dependentsOf(id).some((mod) => on.has(mod))) {
      setOutcome(null);
      setAskingOff(id);
      return;
    }
    turnOff(id);
  };

  const onPreset = (id: PresetId) => {
    if (saving || migration) return;
    const preset = PRESETS[id];
    const next = MODULE_IDS.filter((mod) => preset.modules.includes(mod));
    const text = next.length === MODULE_IDS.length
      ? `Switched to ${preset.label}: every feature is on.`
      : `Switched to ${preset.label}: ${next.length} of ${MODULE_IDS.length} features on.`;
    void commit(next, 'presets', text, enabled);
  };

  const closeQuestion = (id: ModuleId, confirmed: boolean) => {
    if (confirmed) turnOff(id);
    else setAskingOff(null);
    // Back to the switch the question came from, whichever way it went.
    toggles.current.get(id)?.focus();
  };

  const lineFor = (anchor: Anchor) => (outcome && outcome.anchor === anchor
    ? <OutcomeLine outcome={outcome} busy={saving} />
    : null);

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5">
      <SettingsSectionHeader
        icon={LayoutGrid}
        title="Features"
        description={DESCRIPTION}
        action={!isDemoMode && read.data?.status === 'ready' && read.data.setupCompleted ? (
          // The first-run wizard, step by step, nothing saved: what a new Owner sees.
          <Button href="/welcome?preview=1" size="sm" variant="ghost" icon={<Eye size={14} aria-hidden="true" />}>
            Preview setup
          </Button>
        ) : null}
      />

      {isDemoMode && (
        <p className="-mt-3 mb-6 text-xs text-zinc-400">Demo workspace: changes last until you reload.</p>
      )}

      {!isDemoMode && read.loading ? (
        <FeaturesSkeleton />
      ) : !isDemoMode && read.failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t load your features.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <>
          {migration && (
            <div role="status" className="mb-6 flex items-start gap-3 rounded-lg bg-amber-500/[0.1] px-3.5 py-3">
              <Database size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">{migration}</p>
                <p className="mt-0.5 text-xs text-zinc-400">Features can be switched once the database is up to date. Until then, everything stays on.</p>
              </div>
            </div>
          )}

          <div>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-medium text-zinc-400">Start from a preset</h3>
              {!current && <span className="text-[11px] text-zinc-400">Custom mix</span>}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {PRESET_IDS.map((id) => (
                <PresetCard key={id} id={id} current={current === id} disabled={!!migration} onPick={onPreset} />
              ))}
            </div>
            {lineFor('presets') && <div className="mt-3">{lineFor('presets')}</div>}
          </div>

          <div className="mt-8 border-t border-white/[0.06] pt-6">
            <h3 className="text-xs font-medium text-zinc-400">Or choose one by one</h3>
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
              <Lock size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
              Projects, tasks, team, notifications, reminders, files and API keys are always on.
            </p>

            <div className="mt-6 space-y-7">
              {MODULE_GROUPS.map((group) => {
                const ids = MODULE_IDS.filter((id) => MODULES[id].group === group.id);
                if (ids.length === 0) return null;
                const headingId = `features-group-${group.id}`;
                return (
                  <div key={group.id} role="group" aria-labelledby={headingId}>
                    <h4 id={headingId} className="mb-3 text-[11px] font-medium text-zinc-400">{group.label}</h4>
                    <ul className="divide-y divide-white/[0.06]">
                      {ids.map((id) => (
                        <ModuleRow
                          key={id}
                          id={id}
                          on={on.has(id)}
                          disabled={!!migration}
                          onToggle={onToggle}
                          toggleRef={(node) => {
                            if (node) toggles.current.set(id, node);
                            else toggles.current.delete(id);
                          }}
                        >
                          {askingOff === id ? (
                            <TurnOffQuestion
                              alsoOff={dependentsOf(id).filter((mod) => on.has(mod))}
                              onConfirm={() => closeQuestion(id, true)}
                              onCancel={() => closeQuestion(id, false)}
                            />
                          ) : lineFor(id)}
                        </ModuleRow>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** The screen's own shape while the first read is out: presets, then grouped rows. */
function FeaturesSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading features">
      <div className="mb-3 h-3 w-32 rounded bg-white/[0.05]" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PRESET_IDS.map((id) => (
          <div key={id} className="h-[132px] rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.06] motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="mt-8 border-t border-white/[0.06] pt-6">
        <div className="h-3 w-36 rounded bg-white/[0.05]" />
        <div className="mt-3 h-8 rounded-lg bg-white/[0.03]" />
        <div className="mt-6 space-y-7">
          {MODULE_GROUPS.map((group) => (
            <div key={group.id}>
              <div className="mb-3 h-2.5 w-20 rounded bg-white/[0.05]" />
              <div className="divide-y divide-white/[0.06]">
                {MODULE_IDS.filter((id) => MODULES[id].group === group.id).map((id) => (
                  <div key={id} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="h-8 w-8 flex-shrink-0 rounded-lg bg-white/[0.05] motion-safe:animate-pulse" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3.5 w-28 rounded bg-white/[0.06]" />
                      <div className="h-3 w-full max-w-md rounded bg-white/[0.04]" />
                      <div className="flex gap-1.5">
                        <div className="h-4 w-20 rounded-md bg-white/[0.04]" />
                        <div className="h-4 w-16 rounded-md bg-white/[0.04]" />
                      </div>
                    </div>
                    <div className="mt-1 h-6 w-11 flex-shrink-0 rounded-full bg-white/[0.06]" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
