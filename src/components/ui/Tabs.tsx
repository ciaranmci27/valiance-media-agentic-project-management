'use client';

import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LivePulse } from '@/components/ui/LivePulse';
import { CountBadge } from '@/components/ui/CountBadge';
import { useIntent } from '@/lib/reads';

/**
 * A page's sections (DESIGN.md Rule 3): an underline tab strip, so it never
 * reads as one more segmented control beside a view switch. Arrow keys, Home
 * and End move between tabs (roving tabindex), as the ARIA tabs pattern
 * expects. Each panel takes `role="tabpanel"`, `id={tabPanelId(prefix, key)}`
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const intent = useIntent();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === -1) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].key);
  };

  // The hairline is on the wrapper. The strip reaches 1px down over it
  // (-mb-px pb-px), so each underline still covers the hairline but stays
  // inside the strip: nothing overflows vertically, and a sideways swipe on a
  // narrow screen scrolls only sideways instead of wobbling up and down.
  return (
    <div className="border-b border-white/[0.08]">
      <div
        role="tablist"
        aria-label={label}
        className="flex items-end gap-1 -mb-px pb-px overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-none"
      >
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(el) => { refs.current[index] = el; }}
              type="button"
              role="tab"
              id={tabId(idPrefix, tab.key)}
              aria-selected={selected}
              aria-controls={tabPanelId(idPrefix, tab.key)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              {...(tab.warm && !selected ? intent(tab.warm) : {})}
              className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium rounded-t-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                selected ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab.label}
              {tab.live && <LivePulse label={tab.liveLabel ?? 'Live'} />}
              {tab.badge && <CountBadge count={tab.badge.count} label={tab.badge.label} />}
              {!!tab.count && (
                <span className={`text-xs tabular-nums ${selected ? 'text-zinc-300' : 'text-zinc-500'}`}>
                  {tab.count}
                </span>
              )}
              <span
                aria-hidden="true"
                className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors ${selected ? 'bg-brand-400' : 'bg-transparent'}`}
              />
            </button>
          );
        })}
      </div>
    </div>
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
