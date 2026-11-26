'use client';

import { Tabs, tabId, tabPanelId, type TabItem } from '@/components/ui/Tabs';

/**
 * The project page's section tabs: the shared underline `Tabs`
 * (`src/components/ui/Tabs.tsx`) with the `project` id prefix. Kept so the
 * pages that use it (project, Agents home, an agent's profile, Finances)
 * keep working; new screens use `Tabs` directly.
 */

export type ProjectTab<K extends string> = TabItem<K>;

export const projectTabId = (key: string) => tabId('project', key);
export const projectPanelId = (key: string) => tabPanelId('project', key);

export function ProjectTabs<K extends string>({ tabs, active, onChange, label = 'Project sections' }: {
  tabs: ProjectTab<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Names the tab list for screen readers. */
  label?: string;
}) {
  const withLive = tabs.map((tab) => (tab.live && !tab.liveLabel ? { ...tab, liveLabel: 'Your timer is running on this project' } : tab));
  return <Tabs tabs={withLive} active={active} onChange={onChange} label={label} idPrefix="project" />;
}
