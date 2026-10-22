'use client';

import { useState } from 'react';
import { ExternalLink, Globe, Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/Button';
import { PortalAnalytics, PortalAnalyticsFilters, usePortalAnalyticsFilters } from './PortalAnalytics';
import { PortalSettingsPanel, portalEnablePatch } from './PortalSettingsPanel';
import { PortalUpdatesPanel } from './PortalUpdatesPanel';
import { PortalSectionsCard } from './PortalSectionsCard';
import { EmptyCard, RailLayout, SubNav, TabToolbar, ToolbarButton, useKeptViews, type SubNavItem } from './TabLayout';

type PortalView = 'portal' | 'activity';

// Two views: what the client gets (Portal) and how they use it (Activity).
const VIEWS: SubNavItem<PortalView>[] = [
  { key: 'portal', label: 'Portal' },
  { key: 'activity', label: 'Activity' },
];

interface ClientPortalTabProps {
  projectId: string;
  /** The URL's ?view=; anything unknown falls back to Portal. */
  view: string | null;
  onViewChange: (view: PortalView) => void;
}

/**
 * The client's own page for this project. Portal: updates and the page's
 * sections in the main column, how it is opened and how it looks in the
 * rail. Activity: how the client has used it, with what they opened most and
 * any failed PIN attempts beside the sessions. While
 * the portal is off the tab is one explanation and the switch to turn it on.
 */
export function ClientPortalTab({ projectId, view, onViewChange }: ClientPortalTabProps) {
  const { getPortalSettings, getPortalUpdates, getProject, upsertPortalSettings } = useApp();
  const settings = getPortalSettings(projectId);
  const project = getProject(projectId);
  const updates = getPortalUpdates(projectId);
  const [addingUpdate, setAddingUpdate] = useState(false);
  const [query, setQuery] = useState('');
  const filters = usePortalAnalyticsFilters();
  const active: PortalView = VIEWS.find((v) => v.key === view)?.key ?? 'portal';
  const kept = useKeptViews(active);

  if (!settings?.enabled) {
    return (
      <EmptyCard
        icon={<Globe />}
        title="The client portal is off"
        description="Turn it on to give this client a private page with the project's progress, updates, invoices, hours and files."
        action={
          <Button
            icon={<Globe size={16} aria-hidden="true" />}
            onClick={() => upsertPortalSettings(projectId, portalEnablePatch(project?.color, !!settings?.welcome_message))}
          >
            Turn on client portal
          </Button>
        }
      />
    );
  }

  // With the Updates section switched off the client never sees updates, so
  // posting them (and the feed, and its search) goes away too.
  const updatesOn = settings.show_updates;
  const portalUrl = settings.token ? `/portal/${settings.token}` : null;
  const openPortal = portalUrl && (
    <ToolbarButton
      variant="secondary"
      icon={<ExternalLink />}
      label="Open portal"
      href={portalUrl}
      target="_blank"
      rel="noopener noreferrer"
    />
  );

  return (
    <>
      <TabToolbar
        search={active === 'portal' && updatesOn && updates.length > 0 ? { value: query, onChange: setQuery, placeholder: 'Search updates' } : undefined}
        filters={<SubNav label="Client portal views" items={VIEWS} active={active} onChange={onViewChange} />}
        extra={active !== 'portal' && (
          <PortalAnalyticsFilters
            hideLocal={filters.hideLocal}
            onHideLocal={filters.setHideLocal}
            hideTeam={filters.hideTeam}
            onHideTeam={filters.setHideTeam}
          />
        )}
        actions={openPortal}
        primary={active === 'portal' && updatesOn && (
          <ToolbarButton icon={<Plus />} label="Add update" onClick={() => setAddingUpdate(true)} />
        )}
      />

      {kept.has('portal') && (
        <div hidden={active !== 'portal'}>
          <RailLayout rail={<PortalSettingsPanel projectId={projectId} />}>
            {updatesOn && (
              <PortalUpdatesPanel projectId={projectId} isAdding={addingUpdate} onAddingChange={setAddingUpdate} query={query} />
            )}
            <PortalSectionsCard projectId={projectId} />
          </RailLayout>
        </div>
      )}

      {kept.has('activity') && settings.id && (
        <div hidden={active !== 'activity'}>
          <PortalAnalytics
            projectId={projectId}
            portalSettingsId={settings.id}
            hideLocal={filters.hideLocal}
            hideTeam={filters.hideTeam}
            onClearFilters={() => {
              filters.setHideLocal(false);
              filters.setHideTeam(false);
            }}
          />
        </div>
      )}
    </>
  );
}
