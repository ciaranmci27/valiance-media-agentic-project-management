'use client';

import { cloneElement, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { ArrowRight, Search, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';

/**
 * Layout pieces every project tab is built from, so the tabs read as one
 * workspace: a toolbar row on top, then either full-width content or a main
 * column with a 340px rail.
 */

interface TabToolbarProps {
  /** Present on every tab that lists things; always first, 256px from sm up, the free width on phones. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** The tab's segmented control: views (Board, List) or filters (Unpaid, Images). */
  filters?: ReactNode;
  /** Context that only shows sometimes, e.g. a selection's bulk actions. */
  extra?: ReactNode;
  /** Secondary buttons, right-aligned, before the primary one. Use ToolbarButton. */
  actions?: ReactNode;
  /** The tab's one primary action, always last. Use ToolbarButton. */
  primary?: ReactNode;
}

/**
 * The row that opens every project tab. Slots, not free children, so every tab
 * reads the same: search, then the view or filter control, then any extras;
 * secondary actions and the one primary action on the right.
 *
 * Phones get the same two rows on every tab: the search with the tab's icon
 * buttons beside it, then the filters and extras. Without a search the buttons
 * sit at the end of the filters row. From sm up the filters group dissolves
 * (`contents`), so the desktop row is one flat line as before.
 */
export function TabToolbar({ search, filters, extra, actions, primary }: TabToolbarProps) {
  if (!search && !filters && !extra && !actions && !primary) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 mb-5">
      {search && (
        <div className="order-1 flex-1 min-w-0 sm:order-none sm:flex-initial sm:w-64">
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
      {(filters || extra) && (
        // empty:hidden: an `extra` that renders nothing must not leave a blank row on phones.
        <div className={`flex flex-wrap items-center gap-3 min-w-0 empty:hidden sm:contents ${search ? 'order-3 w-full' : 'order-1 flex-1'}`}>
          {filters && <div className="max-w-full overflow-x-auto scrollbar-none">{filters}</div>}
          {extra}
        </div>
      )}
      {(actions || primary) && (
        <div className="order-2 self-start flex flex-wrap items-center gap-2 ml-auto sm:order-none sm:self-auto">
          {actions}
          {primary}
        </div>
      )}
    </div>
  );
}

type ButtonProps = ComponentProps<typeof Button>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type ToolbarButtonProps = DistributiveOmit<ButtonProps, 'children' | 'icon' | 'size' | 'aria-label'> & {
  /** A lucide icon element, e.g. <Plus />; sized and hidden from readers here. */
  icon: ReactElement<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;
  /** The button's text from sm up, and its accessible name everywhere. */
  label: string;
};

/**
 * A TabToolbar action or primary button. From sm up it is a normal Button with
 * its label; on phones it is a 36px square icon button, the height of the
 * search and the SubNav, so the toolbar keeps to two rows on every tab.
 * `title` defaults to the label so the icon still explains itself on hover.
 */
export function ToolbarButton({ icon, label, title, className = '', ...rest }: ToolbarButtonProps) {
  return (
    <Button
      {...(rest as ButtonProps)}
      icon={cloneElement(icon, { size: 16, 'aria-hidden': 'true' })}
      aria-label={label}
      title={title ?? label}
      className={`h-9 whitespace-nowrap max-sm:w-9 max-sm:!px-0 ${className}`}
    >
      <span className="hidden sm:inline">{label}</span>
    </Button>
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

interface RailCardProps {
  /** Sentence case, e.g. "Recent activity". */
  title: string;
  /** A 16px lucide icon in text-zinc-400, aria-hidden. Every titled card has one. */
  icon: ReactNode;
  /** Right-aligned in the header: a CardLink, a count, a toggle. */
  action?: ReactNode;
  /** A muted line under the heading saying what the card is for. */
  description?: ReactNode;
  /** Extra classes on the card itself, e.g. overflow-hidden or a flex layout. */
  className?: string;
  /** Replaces the body's px-5 pb-5, e.g. for a list that runs edge to edge. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The one titled card on every project tab: settings, summaries, lists. Same
 * header everywhere, a 16px icon and a small semibold title with an optional
 * action on the right, so the tabs read as one workspace.
 */
export function RailCard({ title, icon, action, description, className, bodyClassName, children }: RailCardProps) {
  const heading = (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
      {icon}
      {title}
    </h2>
  );
  return (
    <section className={`glass-card rounded-xl ${className ?? ''}`}>
      <div className={`px-5 pt-4 pb-3 flex ${description ? 'items-start' : 'items-center'} justify-between gap-3`}>
        {description ? (
          <div className="min-w-0">
            {heading}
            <p className="mt-1 text-xs text-zinc-400">{description}</p>
          </div>
        ) : heading}
        {action}
      </div>
      <div className={bodyClassName ?? 'px-5 pb-5'}>{children}</div>
    </section>
  );
}

/** A card header's text link into the place that owns the content. */
export function CardLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

/**
 * A card header's text button that acts in place (Change, Done, a modal).
 * Same look as CardLink without the arrow: the arrow means "takes you elsewhere".
 */
export function CardAction({ onClick, children, ...aria }: {
  onClick: () => void;
  children: ReactNode;
  'aria-expanded'?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...aria}
      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </button>
  );
}

/**
 * The one small uppercase label: list groups, day headings, form sections.
 * `as` keeps heading semantics where the label titles a group (h3).
 */
export function GroupLabel({ children, className = 'mb-1.5', as: Tag = 'p' }: {
  children: ReactNode;
  className?: string;
  as?: 'p' | 'h3' | 'span';
}) {
  return <Tag className={`text-[11px] font-semibold uppercase tracking-wider text-zinc-400 ${className}`}>{children}</Tag>;
}

interface EmptyCardProps {
  /** A lucide icon element; sized and coloured here, e.g. <Clock />. */
  icon: ReactElement<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>;
  title: string;
  description?: ReactNode;
  /** Only when it is the natural first step and not already in the toolbar. */
  action?: ReactNode;
}

/** The standard empty state for a tab with nothing in it yet. */
export function EmptyCard({ icon, title, description, action }: EmptyCardProps) {
  return (
    <div className="glass-card rounded-xl flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
        {cloneElement(icon, { size: 18, className: 'text-zinc-500', 'aria-hidden': 'true' })}
      </div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {description && <p className="text-xs text-zinc-400 mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** The line inside a list card when the search or filter hides everything. */
export function NoMatches({ children }: { children: ReactNode }) {
  return <p className="px-5 py-10 text-center text-sm text-zinc-400">{children}</p>;
}

/** One placeholder bar in a skeleton; size and shape it with classes. */
export function Bone({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded bg-white/[0.06] motion-safe:animate-pulse ${className}`} />;
}

/**
 * A loading placeholder shaped like what it stands in for, so nothing jumps
 * when the content lands. Readers hear the label once instead of the bones.
 */
export function Skeleton({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={className}>
      {children}
    </div>
  );
}

/**
 * The views a tab has opened so far. Each stays mounted once seen (hidden when
 * not active), so switching back shows it as it was instead of loading again.
 */
export function useKeptViews<K extends string>(active: K): ReadonlySet<K> {
  const [seen, setSeen] = useState<ReadonlySet<K>>(() => new Set([active]));
  if (!seen.has(active)) setSeen(new Set([...seen, active]));
  return seen.has(active) ? seen : new Set([...seen, active]);
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
