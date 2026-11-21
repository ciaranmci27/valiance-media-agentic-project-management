'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /inbox segment: the Inbox module must be on and the
 * person must be able to read an inbox.
 */
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="inbox" anyOf={['inbound_email.read', 'inbound_email.manage', 'inbound_email.personal']}>{children}</ModulePage>;
}
