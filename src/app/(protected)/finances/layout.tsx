'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /finances segment. Billing needs time tracking, so
 * time is the module that keeps the page: with billing off it holds only time
 * approvals, and with time off too there is nothing left to show. Billing's
 * own pages under it gate on billing as well.
 */
export default function FinancesLayout({ children }: { children: React.ReactNode }) {
  return (
    <ModulePage module="time" anyOf={['finance.company.read', 'earnings.own.read', 'time.approve', 'invoices.read']}>
      {children}
    </ModulePage>
  );
}
