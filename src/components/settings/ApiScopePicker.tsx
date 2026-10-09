'use client';

import { useId, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/inputs/Checkbox';

interface ApiScopePickerProps {
  /** Scopes a key for this member may carry, in the order the API lists them. */
  available: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** One line under the legend. */
  hint?: ReactNode;
  /** One line under the list. */
  note?: ReactNode;
  /** Shown when there is nothing to choose. */
  emptyText?: string;
}

/**
 * The API scope checklist used by New key and Edit key. A ticked scope the
 * member no longer holds stays listed, flagged, so it can be unticked.
 */
export function ApiScopePicker({
  available,
  selected,
  onChange,
  hint,
  note,
  emptyText = 'No API scopes are enabled for your account.',
}: ApiScopePickerProps) {
  const hintId = useId();
  const noteId = useId();
  const unheld = selected.filter((scope) => !available.includes(scope));
  const toggle = (scope: string, checked: boolean) =>
    onChange(checked ? [...selected, scope] : selected.filter((item) => item !== scope));
  const describedBy = [hint ? hintId : null, note ? noteId : null].filter(Boolean).join(' ') || undefined;

  return (
    <fieldset aria-describedby={describedBy}>
      <legend className="block text-sm font-medium text-zinc-300 mb-1.5">API scopes</legend>
      {hint && (
        <p id={hintId} className="text-xs text-zinc-400 mb-2">
          {hint}
        </p>
      )}
      {/* relative: the visually hidden checkboxes position inside the list, so focusing one never scrolls an outer frame. */}
      <div className="relative max-h-52 overflow-y-auto rounded-lg border border-white/[0.08] bg-surface-raised divide-y divide-white/[0.06]">
        {available.map((scope) => (
          <Checkbox
            key={scope}
            size="sm"
            checked={selected.includes(scope)}
            onChange={(checked) => toggle(scope, checked)}
            label={<span className="font-mono text-xs font-normal text-zinc-300">{scope}</span>}
            className="w-full px-3 py-2"
          />
        ))}
        {unheld.map((scope) => (
          <Checkbox
            key={scope}
            size="sm"
            checked
            onChange={(checked) => toggle(scope, checked)}
            label={
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs font-normal text-zinc-300">{scope}</span>
                <span className="text-xs text-amber-400">No longer allowed, untick it</span>
              </span>
            }
            className="w-full px-3 py-2"
          />
        ))}
        {available.length === 0 && unheld.length === 0 && (
          <p className="px-3 py-3 text-xs text-zinc-400">{emptyText}</p>
        )}
      </div>
      {note && (
        <p id={noteId} className="text-xs text-zinc-400 mt-2">
          {note}
        </p>
      )}
    </fieldset>
  );
}
