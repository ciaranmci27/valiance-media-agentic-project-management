'use client';

import { Inbox } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { InboxView } from '@/components/inbox/InboxView';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

export default function InboxPage() {
  const { access } = useAuth();
  const canRead = hasPermission(access, 'inbound_email.read') || hasPermission(access, 'inbound_email.manage');

  return (
    // A full-height column: the inbox fills what the header leaves, with the
    // same gap below it as at its sides.
    <div className="animate-fadeIn flex h-dvh flex-col">
      <Header title="Inbox" subtitle="Client email, triaged by your agents. Read only: reply from your own mail." />
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-4 lg:px-6 lg:pb-6">
        {canRead ? (
          <InboxView />
        ) : (
          <div className="glass-card flex flex-col items-center gap-2 rounded-xl px-6 py-16 text-center">
            <Inbox size={24} className="text-zinc-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-white">You cannot read the inbox</h2>
            <p className="text-xs text-zinc-400">Ask the owner to give you access to an inbox.</p>
          </div>
        )}
      </div>
    </div>
  );
}
