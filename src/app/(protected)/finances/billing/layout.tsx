'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/** Upcoming invoices: billing must be on and the person must read invoices. */
export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="billing" anyOf={['invoices.read']}>{children}</ModulePage>;
}
