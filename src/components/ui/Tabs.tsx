'use client';

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { LivePulse } from '@/components/ui/LivePulse';
import { CountBadge } from '@/components/ui/CountBadge';
import { useIntent } from '@/lib/reads';
import { Popover } from '@/components/ui/Popover';
import { fitTabs } from '@/lib/tab-overflow';

/**
 * A page's sections (DESIGN.md Rule 3): an underline tab strip, so it never
 * reads as one more segmented control beside a view switch. Arrow keys, Home
 * and End move between tabs (roving tabindex), as the ARIA tabs pattern
 * expects. A row too narrow for every tab keeps what fits, the open tab
 * always among them, and puts the rest under More (lib/tab-overflow), so tabs
 * never slide off a phone's screen. Each panel takes `role="tabpanel"`, `id={tabPanelId(prefix, key)}`
 * and `aria-labelledby={tabId(prefix, key)}`.
 *
 * For two to four views or states inside a section, use `SubNav` below.
 */

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** Small count after the label, e.g. open tasks. Hidden when 0 or absent. */
  count?: number;
  /** Shows the live pulse after the label, e.g. Time tracking while your timer runs. */
  live?: boolean;
  /** Says what the live pulse means, for screen readers. */
  liveLabel?: string;
  /** A count badge after the label (CountBadge), e.g. unread tasks; hidden at 0. */
  badge?: { count: number; label: string };
  /** Warms what the tab reads (reads.ts) when the pointer rests on it or it takes focus. */
  warm?: () => void;
}

export const tabId = (prefix: string, key: string) => `${prefix}-tab-${key}`;
export const tabPanelId = (prefix: string, key: string) => `${prefix}-panel-${key}`;

export function Tabs<K extends string>({ tabs, active, onChange, label, idPrefix = 'page' }: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Names the tab list for screen readers. */
  label: string;
  /** Prefix for the tab and panel ids; unique on the page. */
  idPrefix?: string;
}) {
  const refs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const intent = useIntent();
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Which tabs sit in the row (fitTabs); null until measured: every tab, as the server drew it.
  const [shownKeys, setShownKeys] = useState<string[] | null>(null);
  const activeIndex = tabs.findIndex((tab) => tab.key === active);
  const tabsKey = tabs.map((tab) => `${tab.key}:${tab.label}:${tab.count ?? ''}:${tab.badge?.count ?? ''}:${tab.live ? 1 : 0}`).join('|');

  // A row too narrow for every tab (a phone) keeps what fits and puts the rest under More,
  // so tabs never slide off screen. The open tab always stays in the row.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const fit = () => {
      const items = [...measure.querySelectorAll<HTMLElement>('[data-measure-tab]')];
      const more = measure.querySelector<HTMLElement>('[data-measure-more]');
      const shown = fitTabs({
        widths: items.map((item) => item.offsetWidth),
        moreWidth: more?.offsetWidth ?? 0,
        available: row.clientWidth,
        activeIndex,
        gap: TAB_GAP,
      });
      const keys = shown.map((index) => tabs[index]?.key).filter(Boolean) as string[];
      setShownKeys((prev) => (prev && prev.join('|') === keys.join('|') ? prev : keys));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    return () => observer.disconnect();
    // tabsKey stands for tabs: a new array each render with the same tabs must not re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey, activeIndex]);

  const visible = shownKeys ? tabs.filter((tab) => shownKeys.includes(tab.key)) : tabs;
  const hidden = shownKeys ? tabs.filter((tab) => !shownKeys.includes(tab.key)) : [];
  const hiddenBadges = hidden.reduce((sum, tab) => sum + (tab.badge?.count ?? 0), 0);

  const choose = (key: K) => {
    onChange(key);
    // A tab chosen from More (or by arrow key) moves into the row: focus it once it is drawn.
    requestAnimationFrame(() => refs.current[key]?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === -1) return;
    e.preventDefault();
    refs.current[tabs[next].key]?.focus();
    choose(tabs[next].key);
  };

  const content = (tab: TabItem<K>, selected: boolean) => (
    <>
      {tab.label}
      {tab.live && <LivePulse label={tab.liveLabel ?? 'Live'} />}
      {tab.badge && <CountBadge count={tab.badge.count} label={tab.badge.label} />}
      {!!tab.count && (
        <span className={`text-xs tabular-nums ${selected ? 'text-zinc-300' : 'text-zinc-500'}`}>
          {tab.count}
        </span>
      )}
    </>
  );

  // The hairline is on the wrapper. The strip reaches 1px down over it
  // (-mb-px pb-px), so each underline still covers the hairline but stays
  // inside the strip.
  return (
    <div className="relative border-b border-white/[0.08]">
      {/* Every tab and More at their natural width, unseen: what fitTabs measures. */}
      <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex h-0 overflow-hidden whitespace-nowrap" style={{ gap: TAB_GAP }}>
        {tabs.map((tab) => (
          <span key={tab.key} data-measure-tab="" className={`${TAB_CLASS} flex-shrink-0`}>{content(tab, false)}</span>
        ))}
        <span data-measure-more="" className={`${TAB_CLASS} flex-shrink-0`}>More<ChevronDown size={14} /></span>
      </div>
      <div
        ref={rowRef}
        role="tablist"
        aria-label={label}
        className="flex items-end -mb-px pb-px overflow-hidden"
        style={{ gap: TAB_GAP }}
      >
        {visible.map((tab) => {
          const selected = tab.key === active;
          const index = tabs.indexOf(tab);
          return (
            <button
              key={tab.key}
              ref={(el) => { refs.current[tab.key] = el; }}
              type="button"
              role="tab"
              id={tabId(idPrefix, tab.key)}
              aria-selected={selected}
              aria-controls={tabPanelId(idPrefix, tab.key)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              {...(tab.warm && !selected ? intent(tab.warm) : {})}
              className={`${TAB_CLASS} flex-shrink-0 rounded-t-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                selected ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {content(tab, selected)}
              <span
                aria-hidden="true"
                className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors ${selected ? 'bg-brand-400' : 'bg-transparent'}`}
              />
            </button>
          );
        })}
        {hidden.length > 0 && (
          <button
            ref={moreRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={`${TAB_CLASS} flex-shrink-0 rounded-t-md text-zinc-400 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500`}
          >
            More
            {hiddenBadges > 0 && <CountBadge count={hiddenBadges} label={`${hiddenBadges} more under More`} />}
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      <Popover
        anchorRef={moreRef}
        open={moreOpen && hidden.length > 0}
        onClose={() => setMoreOpen(false)}
        width={208}
        className="rounded-lg border border-white/10 bg-surface-overlay py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)]"
      >
        {hidden.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="menuitem"
            onClick={() => { setMoreOpen(false); choose(tab.key); }}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:bg-white/[0.06]"
          >
            {content(tab, false)}
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** The space between tabs, in px (gap-1). */
const TAB_GAP = 4;
const TAB_CLASS = 'relative flex items-center gap-1.5 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium';

export interface SubNavItem<K extends string> {
  key: K;
  label: string;
  count?: number;
  icon?: LucideIcon;
  /** Shown from sm up; phones show the icon alone when one is set. */
  hideLabelOnMobile?: boolean;
}

/**
 * Two to four views or states within one section (DESIGN.md Rule 3): a
 * segmented control, so it reads as a level below the underline tab bar.
 * Arrow keys move between the options.
 */
export function SubNav<K extends string>({ items, active, onChange, label }: {
  items: SubNavItem<K>[];
  active: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    if (next === -1) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].key);
  };
  return (
    <div className="seg-track" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={(el) => { refs.current[index] = el; }}
          type="button"
          role="tab"
          aria-selected={item.key === active}
          tabIndex={item.key === active ? 0 : -1}
          aria-label={item.icon && item.hideLabelOnMobile ? item.label : undefined}
          onClick={() => onChange(item.key)}
          onKeyDown={(e) => onKeyDown(e, index)}
          className={`seg-item flex items-center gap-1.5 whitespace-nowrap ${item.key === active ? 'is-active' : ''}`}
        >
          {item.icon && <item.icon size={16} aria-hidden="true" />}
          <span className={item.icon && item.hideLabelOnMobile ? 'hidden sm:inline' : undefined}>{item.label}</span>
          {!!item.count && <span className="text-xs tabular-nums text-zinc-400">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
