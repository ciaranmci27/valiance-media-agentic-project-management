'use client';

import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { MODULE_ICONS } from '@/components/modules/module-icons';
import { MODULES, type ModuleId } from '@/lib/modules/registry';
import { moduleList } from './workspace-modules';

/**
 * One module: its icon, what it is for, the places it adds, and its switch.
 * Whatever the last change left (the Undo line, or the question before a
 * switch takes others with it) sits under the row, in `children`.
 */
export function ModuleRow({ id, on, disabled = false, toggleRef, onToggle, children }: {
  id: ModuleId;
  on: boolean;
  disabled?: boolean;
  toggleRef?: Ref<HTMLButtonElement>;
  onToggle: (id: ModuleId, on: boolean) => void;
  children?: ReactNode;
}) {
  const definition = MODULES[id];
  const Icon = MODULE_ICONS[id];
  const descriptionId = useId();
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors ${
            on ? 'bg-brand-500/[0.12] text-brand-300 ring-brand-500/20' : 'bg-white/[0.04] text-zinc-400 ring-white/[0.06]'
          }`}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-sm font-medium text-zinc-100">{definition.label}</p>
            {definition.dependsOn.length > 0 && (
              <span className="text-[11px] text-zinc-400">Needs {moduleList(definition.dependsOn)}</span>
            )}
          </div>
          <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-zinc-400">{definition.description}</p>
          <ul aria-label={`${definition.label} adds`} className="mt-2 flex flex-wrap gap-1.5">
            {definition.adds.map((place) => (
              <li key={place} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-zinc-400">{place}</li>
            ))}
          </ul>
        </div>
        <Toggle
          ref={toggleRef}
          checked={on}
          disabled={disabled}
          onChange={(next) => onToggle(id, next)}
          aria-label={definition.label}
          aria-describedby={descriptionId}
          className="mt-1 flex-shrink-0"
        />
      </div>
      {children && <div className="mt-3 sm:pl-11">{children}</div>}
    </li>
  );
}

/**
 * Asked in place, before a switch turns off modules that need it: what else
 * goes, then Turn off or Cancel. Opens with focus on Turn off; Escape cancels.
 */
export function TurnOffQuestion({ alsoOff, onConfirm, onCancel }: {
  alsoOff: ModuleId[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Turn off"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-500/[0.1] px-2.5 py-2"
    >
      <AlertTriangle size={13} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-xs text-zinc-200">Also turns off {moduleList(alsoOff)}.</p>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="secondary" onClick={onConfirm}>Turn off</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
