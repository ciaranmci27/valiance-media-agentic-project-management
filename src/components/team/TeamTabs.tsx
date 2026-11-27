'use client';

import { useRouter } from 'next/navigation';
import { Tabs, tabId, tabPanelId } from '@/components/ui/Tabs';

export type TeamTab = 'people' | 'groups';

/** Where each Team tab lives. Both stay their own address, so old links to /team/groups keep working. */
export const TEAM_TAB_HREF: Record<TeamTab, string> = { people: '/team', groups: '/team/groups' };

/** Props for the element that holds a Team tab's content. */
export const teamPanelProps = (tab: TeamTab) => ({
  role: 'tabpanel' as const,
  id: tabPanelId('team', tab),
  'aria-labelledby': tabId('team', tab),
});

/**
 * Team's sections, People and Groups, as underline tabs under the page
 * header (DESIGN.md Rule 3), in place of a Groups button in the header.
 */
export function TeamTabs({ active }: { active: TeamTab }) {
  const router = useRouter();
  return (
    <div className="px-4 pt-4 lg:px-6">
      <Tabs
        label="Team sections"
        idPrefix="team"
        active={active}
        onChange={(tab) => { if (tab !== active) router.push(TEAM_TAB_HREF[tab]); }}
        tabs={[{ key: 'people', label: 'People' }, { key: 'groups', label: 'Groups' }]}
      />
    </div>
  );
}
