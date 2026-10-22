'use client';

import { useState } from 'react';
import { ExternalLink, Route } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ProjectEmailsPanel } from '@/components/inbox/ProjectEmailsPanel';
import { ProjectEmailRoutingModal } from '@/components/inbox/ProjectEmailRoutingModal';
import { CommunicationHistory } from './ClientCommunicationsLogPanel';
import { CommunicationAutomationCard, SendClientEmailButtons } from './ClientCommunicationsPanel';
import { RailLayout, SubNav, TabToolbar, type SubNavItem } from './TabLayout';

type CommunicationView = 'inbox' | 'sent';

interface CommunicationTabProps {
  projectId: string;
  /** The URL's ?view=; anything unknown falls back to the first view. */
  view: string | null;
  onViewChange: (view: CommunicationView) => void;
  canReadInbox: boolean;
  canReadSent: boolean;
  onOpenPortal: () => void;
}

/**
 * Everything said with the client: email that came in (Inbox) and email that
 * went out (Sent), with the sending tools and alert automation beside it.
 */
export function CommunicationTab({ projectId, view, onViewChange, canReadInbox, canReadSent, onOpenPortal }: CommunicationTabProps) {
  const [routingOpen, setRoutingOpen] = useState(false);
  const [sentRefresh, setSentRefresh] = useState(0);
  // Each view keeps its own search, so switching back finds it as it was.
  const [inboxQuery, setInboxQuery] = useState('');
  const [sentQuery, setSentQuery] = useState('');

  const views: SubNavItem<CommunicationView>[] = [
    ...(canReadInbox ? [{ key: 'inbox' as const, label: 'Inbox' }] : []),
    ...(canReadSent ? [{ key: 'sent' as const, label: 'Sent' }] : []),
  ];
  const active = views.find((v) => v.key === view)?.key ?? views[0]?.key;
  if (!active) return null;

  return (
    <>
      <TabToolbar
        search={{
          value: active === 'inbox' ? inboxQuery : sentQuery,
          onChange: active === 'inbox' ? setInboxQuery : setSentQuery,
          placeholder: active === 'inbox' ? 'Search email' : 'Search sent email',
        }}
        filters={views.length > 1 && <SubNav label="Communication views" items={views} active={active} onChange={onViewChange} />}
        actions={
          active === 'inbox' ? (
            <>
              <Button variant="secondary" icon={<Route size={16} aria-hidden="true" />} onClick={() => setRoutingOpen(true)}>
                Routing
              </Button>
              <Button variant="secondary" icon={<ExternalLink size={16} aria-hidden="true" />} href={`/inbox?project=${projectId}`}>
                Open in Inbox
              </Button>
            </>
          ) : (
            <SendClientEmailButtons projectId={projectId} onSent={() => setSentRefresh((n) => n + 1)} />
          )
        }
      />

      {active === 'inbox' && <ProjectEmailsPanel projectId={projectId} onSetUpRouting={() => setRoutingOpen(true)} searchQuery={inboxQuery} />}

      {active === 'sent' && (
        <RailLayout rail={<CommunicationAutomationCard projectId={projectId} onOpenPortal={onOpenPortal} />}>
          <CommunicationHistory projectId={projectId} refreshSignal={sentRefresh} query={sentQuery} />
        </RailLayout>
      )}

      <ProjectEmailRoutingModal isOpen={routingOpen} onClose={() => setRoutingOpen(false)} projectId={projectId} />
    </>
  );
}
