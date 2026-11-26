'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Filter } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';

/**
 * The one filter control above a list (DESIGN.md Rule 3): a button that
 * counts the active filters and opens a panel of sections. For two to four
 * views or states use SubNav instead; never a row of Selects or pill chips
 * above a list.
 *
 *   <FilterButton activeCount={n} onClear={clear}>
 *     <FilterSection label="Status">
 *       <FilterOption selected={...} onToggle={...}>In progress</FilterOption>
 *     </FilterSection>
 *   </FilterButton>
 */
export function FilterButton({ activeCount, onClear, label = 'Filter', title = 'Filters', width = 320, align = 'end', children }: {
  /** How many filters are on; shown on the button. */
  activeCount: number;
  /** Turns every filter off; shown in the panel while any is on. */
  onClear?: () => void;
  /** The button's word from sm up (phones show the icon). */
  label?: string;
  /** The panel's heading. */
  title?: string;
  width?: number;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = activeCount > 0;

  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={active ? `${label}, ${activeCount} active` : label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`h-9 flex items-center gap-2 px-3 text-sm rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          active ? 'bg-brand-500/15 border border-brand-500/30 text-brand-300' : 'liquid-glass text-zinc-300'
        }`}
      >
        <Filter size={16} aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
        {active && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-xs tabular-nums text-white">{activeCount}</span>}
      </button>

      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        width={width}
        className="bg-surface-raised rounded-xl shadow-xl border border-white/[0.08] p-4 space-y-4"
      >
        <div role="dialog" aria-label={title} className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
            {active && onClear && (
              <button
                type="button"
                onClick={onClear}
                className="rounded text-xs text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Clear all
              </button>
            )}
          </div>
          {children}
        </div>
      </Popover>
    </div>
  );
}

/** One group of options inside a FilterButton's panel. */
export function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <p className="mb-2 text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/** One option inside a FilterSection: pressed when on. */
export function FilterOption({ selected, onToggle, children, className = '' }: {
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        selected
          ? 'border-brand-500/30 bg-brand-500/15 text-brand-300'
          : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20'
      } ${className}`}
    >
      {children}
    </button>
  );
}
