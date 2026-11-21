'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /leads segment: the pipeline and each lead. The
 * Leads module must be on and the person must be able to read leads.
 */
export default function LeadsLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="sales" anyOf={['leads.read', 'leads.read_all', 'leads.manage']}>{children}</ModulePage>;
}
