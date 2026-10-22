'use client';

import { useRef, type KeyboardEvent } from 'react';

export interface ProjectTab<K extends string> {
  key: K;
  label: string;
  /** Small count after the label, e.g. open tasks. Hidden when 0 or absent. */
  count?: number;
}

interface ProjectTabsProps<K extends string> {
  tabs: ProjectTab<K>[];
  active: K;
  onChange: (key: K) => void;
}

export const projectTabId = (key: string) => `project-tab-${key}`;
export const projectPanelId = (key: string) => `project-panel-${key}`;

/**
 * Page-level tab bar for the project page: an underline strip, so it never
 * reads as one more segmented control beside the task view toggle. Arrow keys
 * move between tabs (roving tabindex), as the ARIA tabs pattern expects.
 */
export function ProjectTabs<K extends string>({ tabs, active, onChange }: ProjectTabsProps<K>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

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

  return (
    <div
      role="tablist"
      aria-label="Project sections"
      className="flex items-end gap-1 border-b border-white/[0.08] overflow-x-auto scrollbar-none"
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="tab"
            id={projectTabId(tab.key)}
            aria-selected={selected}
            aria-controls={projectPanelId(tab.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium rounded-t-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
              selected ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tab.label}
            {!!tab.count && (
              <span className={`text-xs font-mono tabular-nums ${selected ? 'text-zinc-300' : 'text-zinc-500'}`}>
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
  );
}
