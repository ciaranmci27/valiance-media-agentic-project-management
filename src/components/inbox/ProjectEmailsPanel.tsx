'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AtSign, ExternalLink, Globe, Mail, Route, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { InboxView } from './InboxView';
import { ProjectEmailRoutingModal } from './ProjectEmailRoutingModal';

const HEADER_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-surface-raised px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/[0.03] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400';

const ROUTES = [
  { icon: Users, title: 'From a contact', body: 'Anyone on this project’s contact list.' },
  { icon: Globe, title: 'From the client’s domain', body: 'Everyone at the company, like @client.com.' },
  { icon: AtSign, title: 'To the project’s address', body: 'Its own address, like project@yourdomain.' },
];

/** The project's client email: the Inbox, locked to this project. */
export function ProjectEmailsPanel({ projectId }: { projectId: string }) {
  const [routingOpen, setRoutingOpen] = useState(false);

  const emptyState = (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto p-6 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]">
        <Mail size={18} className="text-zinc-400" aria-hidden="true" />
      </div>
      <p className="text-sm font-semibold text-white">No email for this project yet</p>
      <p className="mt-1 max-w-md text-xs text-zinc-400">Client email lands here when it comes in one of these ways.</p>
      <ul className="mt-5 grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3">
        {ROUTES.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-zinc-400">
              <Icon size={14} aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-white">{title}</p>
            <p className="mt-1 text-xs text-zinc-400">{body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-5">
        <Button variant="secondary" size="sm" icon={<Route size={14} aria-hidden="true" />} onClick={() => setRoutingOpen(true)}>
          Set up email routing
        </Button>
      </div>
    </div>
  );

  return (
    <section aria-labelledby={`project-emails-${projectId}`} className="glass-card mt-6 flex h-[600px] flex-col overflow-hidden rounded-xl">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-center gap-2">
          <Mail size={18} className="text-zinc-400" aria-hidden="true" />
          <h2 id={`project-emails-${projectId}`} className="font-semibold text-white">Emails</h2>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setRoutingOpen(true)} className={HEADER_BUTTON}>
            <Route size={14} aria-hidden="true" />
            Routing
          </button>
          <Link href={`/inbox?project=${projectId}`} className={HEADER_BUTTON}>
            <ExternalLink size={14} aria-hidden="true" />
            Open in Inbox
          </Link>
        </div>
      </div>
      <InboxView projectId={projectId} embedded emptyState={emptyState} />
      <ProjectEmailRoutingModal isOpen={routingOpen} onClose={() => setRoutingOpen(false)} projectId={projectId} />
    </section>
  );
}
