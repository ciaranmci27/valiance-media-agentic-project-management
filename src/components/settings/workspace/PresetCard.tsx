'use client';

import { Loader2 } from 'lucide-react';
import { MODULE_IDS, PRESETS, type PresetId } from '@/lib/modules/registry';
import { moduleList } from './workspace-modules';

/** What a preset switches on, in one quiet line. */
function presetSummary(id: PresetId): string {
  const modules = PRESETS[id].modules;
  return modules.length === MODULE_IDS.length ? 'Everything on' : `On: ${moduleList(MODULE_IDS.filter((m) => modules.includes(m)))}`;
}

/**
 * One preset as a card you press to apply it. Full (Settings > Features)
 * adds what it switches on and marks the current one; compact (the
 * Dashboard's setup card) is the label and its line only.
 */
export function PresetCard({ id, current = false, compact = false, busy = false, disabled = false, onPick }: {
  id: PresetId;
  current?: boolean;
  compact?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPick: (id: PresetId) => void;
}) {
  const preset = PRESETS[id];
  return (
    <button
      type="button"
      aria-pressed={compact ? undefined : current}
      disabled={disabled}
      // The current preset stays focusable and announced; pressing it again changes nothing.
      onClick={() => { if (!current) onPick(id); }}
      className={`flex h-full w-full flex-col rounded-xl text-left ring-1 ring-inset transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${
        compact ? 'p-3' : 'p-3.5'
      } ${
        current
          ? 'bg-brand-500/[0.08] ring-brand-500/30'
          : 'bg-white/[0.03] ring-white/[0.06] enabled:hover:bg-white/[0.05] enabled:hover:ring-white/[0.1]'
      }`}
    >
      <span className="flex min-h-5 items-center justify-between gap-2">
        <span className="text-sm font-medium text-zinc-100">{preset.label}</span>
        {busy && <Loader2 size={14} className="flex-shrink-0 animate-spin text-zinc-400" aria-hidden="true" />}
        {current && !busy && (
          <span className="flex-shrink-0 rounded-full bg-brand-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-brand-300">Current</span>
        )}
      </span>
      <span className={`mt-1 text-xs leading-relaxed text-zinc-400 ${compact ? 'line-clamp-2' : ''}`}>{preset.description}</span>
      {!compact && <span className="mt-auto pt-3 text-[11px] leading-relaxed text-zinc-400">{presetSummary(id)}</span>}
    </button>
  );
}
