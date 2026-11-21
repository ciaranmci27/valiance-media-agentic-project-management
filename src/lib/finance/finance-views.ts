import { hasPermission, isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';

/**
 * What a person sees of money and time, worked out once so the sidebar, the
 * Finances page and the Time page always agree on the name and the tabs.
 *
 * - Client invoicing (`billing`) adds the company Overview and invoices.
 * - Team pay (`team_pay`) adds Payroll for whoever runs pay, and My earnings
 *   for everyone else who is paid.
 * - Time tracking adds the timesheet: your own hours, the team's for people
 *   who read all time, and the review queue where approvals exist.
 *
 * With no money view the timesheet is its own page, /time. With one, it is
 * the Time tab of /finances. A permission of a switched-off module is held by
 * nobody, so the permission checks below carry the module checks.
 */

export type FinanceTab = 'overview' | 'time' | 'payroll' | 'earnings';

export type FinanceEntryKind = 'finances' | 'earnings' | 'time';

export interface FinanceEntry {
  href: '/finances' | '/time';
  /** The sidebar label and the page title: always the same words. */
  label: string;
  kind: FinanceEntryKind;
}

export interface FinanceViews {
  /** The page's tabs, in order; the first opens by default. */
  tabs: FinanceTab[];
  /** The sidebar entry, or null when there is nothing to open. */
  entry: FinanceEntry | null;
  /** Reads invoices: the page offers Upcoming invoices. */
  invoices: boolean;
}

export const FINANCE_TAB_LABELS: Record<FinanceTab, string> = {
  overview: 'Overview',
  time: 'Time',
  payroll: 'Payroll',
  earnings: 'My earnings',
};

/** Any of these opens the timesheet. */
export const TIME_PERMISSIONS: PermissionKey[] = ['time.manage_own', 'time.read_all', 'time.manage_all', 'time.approve'];

/** Any of these, or a time permission, lets a person into /finances (its layout uses the same set). */
export const FINANCE_PERMISSIONS: PermissionKey[] = [
  'finance.company.read', 'invoices.read', 'compensation.manage', 'payouts.manage', 'earnings.own.read',
];

export function canUseTimesheet(access: AccessContext | null | undefined): boolean {
  return TIME_PERMISSIONS.some((key) => hasPermission(access, key));
}

/**
 * Whether finished hours wait for someone's approval. With Client invoicing
 * and Team pay both off no money rides on them, so the database approves
 * every finished entry as it is logged and there is nothing to review.
 */
export function hourApprovalsExist(access: AccessContext | null | undefined): boolean {
  return isModuleEnabled(access, 'time') && (isModuleEnabled(access, 'billing') || isModuleEnabled(access, 'team_pay'));
}

export function financeViews(access: AccessContext | null | undefined): FinanceViews {
  const time = canUseTimesheet(access);
  const overview = hasPermission(access, 'finance.company.read');
  const invoices = hasPermission(access, 'invoices.read');
  const payroll = hasPermission(access, 'compensation.manage') || hasPermission(access, 'payouts.manage');
  // Whoever runs payroll sees their own line in it.
  const earnings = !payroll && hasPermission(access, 'earnings.own.read');
  const teamTime = hasPermission(access, 'time.read_all') || hasPermission(access, 'time.approve');

  if (!overview && !invoices && !payroll && !earnings) {
    return time
      ? { tabs: ['time'], entry: { href: '/time', label: 'Time', kind: 'time' }, invoices: false }
      : { tabs: [], entry: null, invoices: false };
  }

  if (overview || invoices || payroll) {
    const tabs: FinanceTab[] = [];
    if (overview) tabs.push('overview');
    if (time) tabs.push('time');
    if (payroll) tabs.push('payroll');
    if (earnings) tabs.push('earnings');
    return { tabs, entry: { href: '/finances', label: 'Finances', kind: 'finances' }, invoices };
  }

  // Own earnings is the only money view. Someone who runs the team's hours
  // (an Admin, say) comes for the timesheet first; everyone else for their pay.
  if (teamTime && time) {
    return { tabs: ['time', 'earnings'], entry: { href: '/finances', label: 'Time', kind: 'time' }, invoices: false };
  }
  return {
    tabs: time ? ['earnings', 'time'] : ['earnings'],
    entry: { href: '/finances', label: 'My earnings', kind: 'earnings' },
    invoices: false,
  };
}
