'use client';

import Link from 'next/link';
import { ExternalLink, Mail } from 'lucide-react';
import { InboxView } from './InboxView';

/** The project's client email: the Inbox, locked to this project. */
export function ProjectEmailsPanel({ projectId }: { projectId: string }) {
  return (
    <section aria-labelledby={`project-emails-${projectId}`} className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail size={18} className="text-zinc-400" aria-hidden="true" />
          <h2 id={`project-emails-${projectId}`} className="font-semibold text-white">Emails</h2>
        </div>
        <Link
          href={`/inbox?project=${projectId}`}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Open in Inbox
          <ExternalLink size={12} aria-hidden="true" />
        </Link>
      </div>
      <InboxView projectId={projectId} embedded />
    </section>
  );
}
