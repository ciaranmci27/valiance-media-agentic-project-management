'use client';

import { ModulePage } from '@/components/modules/ModuleGate';
import { TIME_PERMISSIONS } from '@/lib/finance/finance-views';

/** The timesheet: Time tracking must be on and the person must use or read time. */
export default function TimeLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="time" anyOf={TIME_PERMISSIONS}>{children}</ModulePage>;
}
