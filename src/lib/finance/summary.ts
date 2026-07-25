// Single source of truth for finance math. `computeFinanceData` holds ALL the money
// rules (range totals, per-project breakdown, and the per-day maps the chart is built
// from). The Finances page consumes it for its overview + chart, and the Dashboard
// consumes it (via computeCompanyFinanceSummary) for its KPI cards, so the two can
// never disagree. The Finances page owns only presentation on top of this (bucketing
// days into bars, axis labels, drilldown), never the money rules.

import type { Project, ProjectInvoice, TimeEntry, TeamMember, EmployeeEarningsData } from '@/lib/types';
import { getWorkedHours, getWorkedHoursByDay } from '@/lib/time-entry-utils';
import { ensureLineItems, spreadLineItem, invoicedTotalsByItemType, totalBillableAmount } from '@/lib/invoice-utils';
import { dayVestingRatio } from '@/lib/finance/vesting';

export interface DateRange { startKey: string; endKey: string }

export interface FinanceEngineInput {
  projects: Project[];
  invoices: ProjectInvoice[];
  timeEntries: TimeEntry[];
  team: TeamMember[];
  rateByProject: Map<string, number>;
  now: number;
  timezone?: string;
  range: DateRange;
  selectedProjectIds?: Set<string>;
}

export interface ProjectFinanceRow {
  id: string;
  name: string;
  color?: string;
  hourlyRate: number | null;
  isHourly: boolean;
  invoiced: number;
  earned: number;
  received: number;
  outstanding: number;
  hours: number;
}

export interface DayProjectWork { hours: number; value: number; teamContribution: number }

export interface FinanceData {
  // Range totals
  earned: number;
  received: number;
  invoiced: number;
  outstanding: number;
  overdue: number;
  hours: number;
  activeInvoicesCount: number;
  // Per-project rows (range-scoped earned/received/invoiced; all-time outstanding)
  projectBreakdown: ProjectFinanceRow[];
  invoicesInRange: ProjectInvoice[];
  // Per-day maps the chart/drilldown are built from (presentation lives in the page)
  workByDay: Map<string, Map<string, DayProjectWork>>;
  fixedByDayProject: Map<string, Map<string, number>>;
  recurringByDayProject: Map<string, Map<string, number>>;
  paymentsByDay: Map<string, number>;
  projectLookup: Map<string, Project>;
}

/**
 * The finance engine. Computes every money figure the app shows from raw workspace
 * data for a given range + project filter. Pure and side-effect free.
 */
export function computeFinanceData(input: FinanceEngineInput): FinanceData {
  const { projects, invoices, timeEntries, team, rateByProject, now, timezone, range } = input;
  const { startKey, endKey } = range;
  const sel = input.selectedProjectIds;
  const filterActive = !!sel && sel.size > 0;
  const fProjects = filterActive ? projects.filter(p => sel!.has(p.id)) : projects;
  const fInvoices = filterActive ? invoices.filter(i => sel!.has(i.project_id)) : invoices;
  const fTimeEntries = filterActive ? timeEntries.filter(t => sel!.has(t.project_id)) : timeEntries;

  // ── Range-aware invoice / payment filters ──
  const invoicesInRange = fInvoices.filter(inv => inv.date >= startKey && inv.date <= endKey);
  const activeInvoices = invoicesInRange.filter(inv => inv.status !== 'cancelled');
  const paymentsInRange = fInvoices.filter(
    inv => inv.status === 'paid' && inv.paid_date && inv.paid_date >= startKey && inv.paid_date <= endKey,
  );
  const overdue = fInvoices.filter(inv => inv.status === 'overdue').reduce((s, i) => s + i.amount, 0);
  const invoiced = activeInvoices.reduce((s, i) => s + i.amount, 0);
  const received = paymentsInRange.reduce((s, i) => s + i.amount, 0);
  const activeInvoicesCount = activeInvoices.length;

  // ── Hours fragmented by calendar day (chart, totals, per-project rows) ──
  const workByDay = new Map<string, Map<string, DayProjectWork>>();
  const hoursByProjectInRange = new Map<string, number>();
  const hourlyEarnedByProjectInRange = new Map<string, number>();
  const teamContributionByProjectInRange = new Map<string, number>();
  const payableMemberIds = new Set(
    team.filter(member => member.role !== 'owner' && member.role !== 'agent').map(member => member.id),
  );
  let hours = 0;
  let hourlyEarnedInRange = 0;
  let teamContributionInRange = 0;

  for (const te of fTimeEntries) {
    const rate = te.hourly_rate ?? rateByProject.get(te.project_id) ?? 0;
    for (const [dayKey, workedHours] of getWorkedHoursByDay(te, now)) {
      if (dayKey < startKey || dayKey > endKey) continue;
      const billableValue = te.work_type === 'internal' ? 0 : workedHours * rate;
      const isEmployee = payableMemberIds.has(te.member_id);
      const isApprovedEmployeeWork = isEmployee && te.approval_status === 'approved';
      const value = isEmployee ? 0 : billableValue;
      const teamContribution = isApprovedEmployeeWork
        ? billableValue - (workedHours * Number(te.compensation_rate || 0))
        : 0;
      hours += workedHours;
      hourlyEarnedInRange += value;
      teamContributionInRange += teamContribution;
      hoursByProjectInRange.set(te.project_id, (hoursByProjectInRange.get(te.project_id) ?? 0) + workedHours);
      hourlyEarnedByProjectInRange.set(te.project_id, (hourlyEarnedByProjectInRange.get(te.project_id) ?? 0) + value);
      teamContributionByProjectInRange.set(te.project_id, (teamContributionByProjectInRange.get(te.project_id) ?? 0) + teamContribution);
      let dayMap = workByDay.get(dayKey);
      if (!dayMap) { dayMap = new Map(); workByDay.set(dayKey, dayMap); }
      const cur = dayMap.get(te.project_id) ?? { hours: 0, value: 0, teamContribution: 0 };
      cur.hours += workedHours;
      cur.value += value;
      cur.teamContribution += teamContribution;
      dayMap.set(te.project_id, cur);
    }
  }

  // Payments received per day (paid_date, range-scoped) — for the chart.
  const paymentsByDay = new Map<string, number>();
  for (const inv of fInvoices) {
    if (inv.status !== 'paid' || !inv.paid_date) continue;
    if (inv.paid_date < startKey || inv.paid_date > endKey) continue;
    paymentsByDay.set(inv.paid_date, (paymentsByDay.get(inv.paid_date) ?? 0) + inv.amount);
  }

  // Amortized fixed/recurring revenue per day, broken down by project, vested to `now`.
  const fixedByDayProject = new Map<string, Map<string, number>>();
  const recurringByDayProject = new Map<string, Map<string, number>>();
  for (const inv of fInvoices) {
    if (inv.status === 'cancelled') continue;
    for (const li of ensureLineItems(inv)) {
      if (li.item_type === 'hourly' || li.item_type === 'reimbursement') continue;
      const bucket = li.item_type === 'recurring' ? recurringByDayProject : fixedByDayProject;
      for (const [dk, dollars] of spreadLineItem(li, inv.date)) {
        if (dk < startKey || dk > endKey) continue;
        const vested = dollars * dayVestingRatio(dk, now, timezone);
        if (vested <= 0) continue;
        if (!bucket.has(dk)) bucket.set(dk, new Map());
        const pmap = bucket.get(dk)!;
        pmap.set(inv.project_id, (pmap.get(inv.project_id) ?? 0) + vested);
      }
    }
  }

  const accruedByProjectInRange = new Map<string, number>();
  let totalAccruedInRange = 0;
  for (const bucket of [fixedByDayProject, recurringByDayProject]) {
    for (const [, pmap] of bucket) {
      for (const [pid, dollars] of pmap) {
        accruedByProjectInRange.set(pid, (accruedByProjectInRange.get(pid) ?? 0) + dollars);
        totalAccruedInRange += dollars;
      }
    }
  }

  const earned = hourlyEarnedInRange + totalAccruedInRange + teamContributionInRange;

  // ── Per-project outstanding (all-time snapshot) ──
  const outstandingByProject = new Map<string, number>();
  for (const p of fProjects) {
    if (p.status === 'archived') continue;
    const pInvoicesAll = fInvoices.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
    const pPaidAll = fInvoices
      .filter(inv => inv.project_id === p.id && inv.status === 'paid')
      .reduce((s, i) => s + i.amount, 0);
    const projectEntries = fTimeEntries.filter(te => te.project_id === p.id);
    const isHourly = !!p.hourly_tracking;
    const rate = p.hourly_rate ?? 0;
    const pInvoicedByType = invoicedTotalsByItemType(pInvoicesAll);
    const pHourlyInvoiced = pInvoicedByType.hourly;
    const pNonHourlyOwed = pInvoicedByType.fixed + pInvoicedByType.recurring + pInvoicedByType.reimbursement;
    const pInvoicedTotal = pInvoicesAll.reduce((s, i) => s + i.amount, 0);
    const pBillable = isHourly
      ? Math.max(
          totalBillableAmount(
            projectEntries.map(te => ({ id: te.id, hours: getWorkedHours(te, now), hourly_rate: te.hourly_rate })),
            rate,
          ),
          pHourlyInvoiced,
        ) + pNonHourlyOwed
      : pInvoicedTotal;
    outstandingByProject.set(p.id, Math.max(0, pBillable - pPaidAll));
  }
  const outstanding = Array.from(outstandingByProject.values()).reduce((s, v) => s + v, 0);

  const projectLookup = new Map(fProjects.map(p => [p.id, p]));

  const projectBreakdown: ProjectFinanceRow[] = fProjects
    .filter(p => p.status !== 'archived')
    .map(p => {
      const pInvoices = invoicesInRange.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
      const pPayments = paymentsInRange.filter(inv => inv.project_id === p.id);
      const pHours = hoursByProjectInRange.get(p.id) ?? 0;
      const pHourlyEarned = hourlyEarnedByProjectInRange.get(p.id) ?? 0;
      const pTeamContribution = teamContributionByProjectInRange.get(p.id) ?? 0;
      const pAccrued = accruedByProjectInRange.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        hourlyRate: p.hourly_rate,
        isHourly: !!p.hourly_tracking,
        invoiced: pInvoices.reduce((s, i) => s + i.amount, 0),
        earned: pHourlyEarned + pAccrued + pTeamContribution,
        received: pPayments.reduce((s, i) => s + i.amount, 0),
        outstanding: outstandingByProject.get(p.id) ?? 0,
        hours: pHours,
      };
    })
    .filter(p => p.invoiced > 0 || p.hours > 0 || p.outstanding > 0 || Math.abs(p.earned) > 0.005)
    .sort((a, b) => b.earned - a.earned);

  return {
    earned, received, invoiced, outstanding, overdue, hours, activeInvoicesCount,
    projectBreakdown, invoicesInRange,
    workByDay, fixedByDayProject, recurringByDayProject, paymentsByDay, projectLookup,
  };
}

// ── Company summary (dashboard KPI cards) — thin view over the engine ──
export interface CompanyFinanceSummary {
  earned: number; received: number; invoiced: number; outstanding: number; overdue: number; hours: number;
}

export function computeCompanyFinanceSummary(input: FinanceEngineInput): CompanyFinanceSummary {
  const d = computeFinanceData(input);
  return { earned: d.earned, received: d.received, invoiced: d.invoiced, outstanding: d.outstanding, overdue: d.overdue, hours: d.hours };
}

// ── Member earnings summary (earnings.own.read) ──
export interface MemberEarningsSummary { earned: number; owed: number }

export function computeMemberEarningsSummary(data: EmployeeEarningsData, range: DateRange): MemberEarningsSummary {
  const { startKey, endKey } = range;
  let earned = 0;
  for (const entry of data.entries) {
    if (entry.approval_status !== 'approved') continue;
    const rate = Number(entry.compensation_rate || 0);
    for (const [dateKey, workedHours] of getWorkedHoursByDay(entry)) {
      if (dateKey < startKey || dateKey > endKey) continue;
      earned += workedHours * rate;
    }
  }
  for (const adjustment of data.adjustments) {
    if (adjustment.voided_at || adjustment.effective_date < startKey || adjustment.effective_date > endKey) continue;
    earned += Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
  }
  const allApproved = data.entries
    .filter(entry => entry.approval_status === 'approved')
    .reduce((sum, entry) => sum + [...getWorkedHoursByDay(entry).values()].reduce((s, v) => s + v, 0) * Number(entry.compensation_rate || 0), 0)
    + data.adjustments
      .filter(item => !item.voided_at)
      .reduce((sum, item) => sum + Number(item.amount) * (item.adjustment_type === 'deduction' ? -1 : 1), 0);
  const allocated = data.allocations.reduce((sum, allocation) => sum + Number(allocation.allocated_amount), 0);
  return { earned, owed: Math.max(0, allApproved - allocated) };
}
