'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /contacts segment: the address book and each
 * contact. The Contacts module must be on and the person must be able to
 * read contacts.
 */
export default function ContactsLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="contacts" anyOf={['contacts.read', 'contacts.read_all']}>{children}</ModulePage>;
}
