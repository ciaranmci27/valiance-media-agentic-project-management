'use client';

import { ModulePage } from '@/components/modules/ModuleGate';
import { FINANCE_PERMISSIONS, TIME_PERMISSIONS } from '@/lib/finance/finance-views';

/**
 * One gate for the whole /finances segment. Client invoicing and Team pay
 * both need time tracking, so time is the module that keeps the page; with
 * time off there is nothing left to show. Anyone with a money view or the
 * timesheet gets in: the page shows the tabs they may see (financeViews), and
 * someone with no money view is sent on to /time. Client invoicing's own
 * pages under it gate on billing as well.
 */
export default function FinancesLayout({ children }: { children: React.ReactNode }) {
  return (
    <ModulePage module="time" anyOf={[...FINANCE_PERMISSIONS, ...TIME_PERMISSIONS]}>
      {children}
    </ModulePage>
  );
}
