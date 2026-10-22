'use client';

import type { ReactNode } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { TextInput } from '@/components/ui/inputs/TextInput';

/**
 * Layout pieces every project tab is built from, so the tabs read as one
 * workspace: a toolbar row on top, then either full-width content or a main
 * column with a 340px rail.
 */

interface TabToolbarProps {
  /** Present on every tab that lists things; always first, always the same width. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** The tab's segmented control: views (Board, List) or filters (Unpaid, Images). */
  filters?: ReactNode;
  /** Context that only shows sometimes, e.g. a selection's bulk actions. */
  extra?: ReactNode;
  /** Secondary buttons, right-aligned, before the primary one. */
  actions?: ReactNode;
  /** The tab's one primary action, always last. */
  primary?: ReactNode;
}

/**
 * The row that opens every project tab. Slots, not free children, so every tab
 * reads the same: search, then the view or filter control, then any extras;
 * secondary actions and the one primary action on the right.
 */
export function TabToolbar({ search, filters, extra, actions, primary }: TabToolbarProps) {
  if (!search && !filters && !extra && !actions && !primary) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 mb-5">
      {search && (
        <div className="w-full sm:w-64">
          <TextInput
            type="search"
            aria-label={search.placeholder}
            placeholder={search.placeholder}
            value={search.value}
            onChange={search.onChange}
            leftIcon={Search}
          />
        </div>
      )}
      {filters && <div className="max-w-full overflow-x-auto scrollbar-none">{filters}</div>}
      {extra}
      {(actions || primary) && (
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {actions}
          {primary}
        </div>
      )}
    </div>
  );
}

interface RailLayoutProps {
  children: ReactNode;
  rail: ReactNode;
  /** Which side the rail sits on at desktop. */
  side?: 'left' | 'right';
  /** Keep the rail in view while the main column scrolls. */
  stickyRail?: boolean;
  /** On phones, show the rail above the main column (e.g. the timer). */
  railFirstOnMobile?: boolean;
}

/** A main column plus a 340px rail from lg up; stacked below. */
export function RailLayout({ children, rail, side = 'right', stickyRail = false, railFirstOnMobile = false }: RailLayoutProps) {
  const railBox = (
    <aside className={`min-w-0 space-y-6 ${stickyRail ? 'lg:sticky lg:top-6' : ''} ${railFirstOnMobile ? 'order-first lg:order-none' : ''}`}>
      {rail}
    </aside>
  );
  return (
    <div
      className={`grid grid-cols-1 gap-6 items-start ${
        side === 'left' ? 'lg:grid-cols-[340px_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1fr)_340px]'
      }`}
    >
      {side === 'left' && railBox}
      <div className="min-w-0 space-y-6">{children}</div>
      {side === 'right' && railBox}
    </div>
  );
}

/** A titled card for rail content: settings, summaries, short lists. */
export function RailCard({ title, icon, action, children }: { title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-card rounded-xl">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

export interface SubNavItem<K extends string> {
  key: K;
  label: string;
  count?: number;
  icon?: LucideIcon;
  /** Shown from sm up; phones show the icon alone when one is set. */
  hideLabelOnMobile?: boolean;
}

/**
 * Views within one tab (Inbox / Sent). A segmented control, so it reads as a
 * level below the underline tab bar.
 */
export function SubNav<K extends string>({ items, active, onChange, label }: {
  items: SubNavItem<K>[];
  active: K;
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <div className="seg-track" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === active}
          aria-label={item.icon && item.hideLabelOnMobile ? item.label : undefined}
          onClick={() => onChange(item.key)}
          className={`seg-item flex items-center gap-1.5 whitespace-nowrap ${item.key === active ? 'is-active' : ''}`}
        >
          {item.icon && <item.icon size={16} aria-hidden="true" />}
          <span className={item.icon && item.hideLabelOnMobile ? 'hidden sm:inline' : undefined}>{item.label}</span>
          {!!item.count && <span className="text-xs font-mono tabular-nums text-zinc-400">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
