'use client';

import { Header } from '@/components/layout/Header';
import { InboxView } from '@/components/inbox/InboxView';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';

/** Who may open it is the segment's layout's call (module on, an inbox to read). */
export default function InboxPage() {
  const { access } = useAuth();
  const subtitle = isModuleEnabled(access, 'agents')
    ? 'Email about your projects, sorted by your agents. Read only: reply from your own mail.'
    : 'Email about your projects, sorted by project. Read only: reply from your own mail.';

  return (
    // A full-height column: the inbox fills what the header leaves, with the
    // same gap below it as at its sides.
    <div className="animate-fadeIn flex h-dvh flex-col">
      <Header title="Inbox" subtitle={subtitle} />
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-4 lg:px-6 lg:pb-6">
        <InboxView />
      </div>
    </div>
  );
}
