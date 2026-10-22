'use client';

import { useState } from 'react';
import { ExternalLink, Globe, Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/Button';
import { PortalAnalytics, PortalAnalyticsFilters, usePortalAnalyticsFilters } from './PortalAnalytics';
import { PortalSettingsPanel, portalEnablePatch } from './PortalSettingsPanel';
import { PortalUpdatesPanel } from './PortalUpdatesPanel';
import { PortalSectionsCard } from './PortalSectionsCard';
import { RailLayout, SubNav, TabToolbar, type SubNavItem } from './TabLayout';

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

  if (!settings?.enabled) {
    return (
      <div className="glass-card rounded-xl flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="w-12 h-12 rounded-full bg-white/[0.06] flex items-center justify-center mb-4">
          <Globe size={20} className="text-zinc-400" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-white">The client portal is off</h2>
        <p className="text-sm text-zinc-400 mt-1.5 max-w-md">
          Turn it on to give this client a private page with the project&apos;s progress, updates,
          invoices, hours and files.
        </p>
        <Button
          className="mt-5"
          icon={<Globe size={16} aria-hidden="true" />}
          onClick={() => upsertPortalSettings(projectId, portalEnablePatch(project?.color, !!settings?.welcome_message))}
        >
          Turn on client portal
        </Button>
      </div>
    );
  }

  const active: PortalView = VIEWS.find((v) => v.key === view)?.key ?? 'portal';
  // With the Updates section switched off the client never sees updates, so
  // posting them (and the feed, and its search) goes away too.
  const updatesOn = settings.show_updates;
  const portalUrl = settings.token ? `/portal/${settings.token}` : null;
  const openPortal = portalUrl && (
    <Button
      variant="secondary"
      icon={<ExternalLink size={16} aria-hidden="true" />}
      href={portalUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open portal
    </Button>
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
          <Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAddingUpdate(true)}>
            Add update
          </Button>
        )}
      />

      {active === 'portal' ? (
        <RailLayout rail={<PortalSettingsPanel projectId={projectId} />}>
          {updatesOn && (
            <PortalUpdatesPanel projectId={projectId} isAdding={addingUpdate} onAddingChange={setAddingUpdate} query={query} />
          )}
          <PortalSectionsCard projectId={projectId} />
        </RailLayout>
      ) : (
        settings.id && (
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
        )
      )}
    </>
  );
}
