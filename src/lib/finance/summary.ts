// Single source of truth for finance math. `computeFinanceData` holds ALL the money
// rules (range totals, per-project breakdown, and the per-day maps the chart is built
// from). The Finances page consumes it for its overview + chart, and the Dashboard
// consumes it (via computeCompanyFinanceSummary) for its KPI cards, so the two can
// never disagree. The Finances page owns only presentation on top of this (bucketing
// days into bars, axis labels, drilldown), never the money rules.

import type { Project, ProjectInvoice, TimeEntry, TeamMember, EmployeeEarningsData, InvoiceLineItem } from '@/lib/types';
import { getWorkedHours, getWorkedHoursByDay, isApprovedTime } from '@/lib/time-entry-utils';
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
  /** Total revenue-split percent per invoice line (see lineShareKey). Empty for
   *  callers who cannot see compensation, which leaves every line at 100%. */
  lineSharePercent?: ReadonlyMap<string, number>;
  /** Retainer months covering today that have no invoice line yet. */
  accruingRetainerLines?: AccruingRetainerLine[];
}

/** One row of the retainer_accruing_lines() RPC. */
export interface AccruingRetainerLine {
  project_id: string;
  retainer_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  share_percent: number;
}

export const lineShareKey = (invoiceId: string, lineItemId: string) => `${invoiceId}:${lineItemId}`;

/** A fixed or recurring line that accrues revenue, with the part owed to split members. */
export interface ServiceAccrualLine {
  projectId: string;
  item: InvoiceLineItem;
  fallbackDate: string;
  /** 0..1 of the line that belongs to split members, not the company. */
  shareRatio: number;
}

/**
 * Every line that vests day by day: real fixed and recurring invoice lines,
 * plus a stand-in for a retainer month that has not been invoiced yet, so an
 * arrears retainer (or a late draft) still ticks during the month it covers.
 */
export function serviceAccrualLines(
  invoices: ProjectInvoice[],
  input: Pick<FinanceEngineInput, 'lineSharePercent' | 'accruingRetainerLines'>,
  projectIncluded: (projectId: string) => boolean = () => true,
): ServiceAccrualLine[] {
  const lines: ServiceAccrualLine[] = [];
  const ratio = (percent: number) => Math.min(1, Math.max(0, percent / 100));
  for (const invoice of invoices) {
    if (invoice.status === 'cancelled' || !projectIncluded(invoice.project_id)) continue;
    for (const item of ensureLineItems(invoice)) {
      if (item.item_type !== 'fixed' && item.item_type !== 'recurring') continue;
      lines.push({
        projectId: invoice.project_id,
        item,
        fallbackDate: invoice.date,
        shareRatio: ratio(input.lineSharePercent?.get(lineShareKey(invoice.id, item.id)) ?? 0),
      });
    }
  }
  for (const accruing of input.accruingRetainerLines ?? []) {
    if (!projectIncluded(accruing.project_id)) continue;
    lines.push({
      projectId: accruing.project_id,
      item: {
        id: `accruing:${accruing.retainer_id}:${accruing.period_start}`,
        position: 0,
        item_type: 'recurring',
        amount: accruing.amount,
        description: '',
        service_start_date: accruing.period_start,
        service_end_date: accruing.period_end,
        recurrence_frequency: 'monthly',
        retainer_id: accruing.retainer_id,
      },
      fallbackDate: accruing.period_start,
      shareRatio: ratio(accruing.share_percent),
    });
  }
  return lines;
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
  /** Billable value of worked time still awaiting approval. Not in `earned`. */
  pendingEarned: number;
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
 * Agent sessions remain in real elapsed time until approval, when the database
 * replaces them with their multiplier-adjusted billed duration. Project the
 * same duration before approval so finance values do not jump during review.
 * Once converted, the stored segments already include the multiplier.
 */
export function projectedBillingMultiplier(entry: TimeEntry): number {
  if (entry.billing_converted_at) return 1;
  const multiplier = Number(entry.billing_multiplier);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

/** Mirror the database's approval-time agent conversion without mutating data. */
export function projectTimeEntryForBilling(entry: TimeEntry, now: number): TimeEntry {
  const multiplier = projectedBillingMultiplier(entry);
  if (multiplier === 1) return entry;

  const startMs = Date.parse(entry.start_time);
  if (!Number.isFinite(startMs)) return entry;
  const billedEnd = new Date(startMs + (getWorkedHours(entry, now) * multiplier * 3_600_000)).toISOString();
  return {
    ...entry,
    end_time: billedEnd,
    segments: [{ start: entry.start_time, end: billedEnd }],
  };
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
  // The owner's own time answers to nobody, so it is revenue the moment it is
  // worked and a running timer ticks up live. Everyone else's time is a request
  // that the owner approves, and a request is not revenue yet.
  const ownerMemberIds = new Set(
    team.filter(member => member.role === 'owner').map(member => member.id),
  );
  let hours = 0;
  let hourlyEarnedInRange = 0;
  let teamContributionInRange = 0;
  let pendingEarnedInRange = 0;

  for (const te of fTimeEntries) {
    const rate = te.hourly_rate ?? rateByProject.get(te.project_id) ?? 0;
    const billingEntry = projectTimeEntryForBilling(te, now);
    for (const [dayKey, workedHours] of getWorkedHoursByDay(billingEntry, now)) {
      if (dayKey < startKey || dayKey > endKey) continue;
      const billableValue = te.work_type === 'internal' ? 0 : workedHours * rate;
      const isEmployee = payableMemberIds.has(te.member_id);
      // Time that needs approving is not revenue until it is approved, and
      // time that needs no approving is revenue as it is worked. Gating the
      // owner's own hours too would have meant a live timer reporting nothing
      // earned all day; gating nobody's meant an agent's disputed session was
      // already counted, so rejecting part of it made the books fall.
      const needsApproval = !ownerMemberIds.has(te.member_id);
      const counts = !needsApproval || te.approval_status === 'approved';
      const isApprovedEmployeeWork = isEmployee && te.approval_status === 'approved';
      const value = isEmployee || !counts ? 0 : billableValue;
      if (!isEmployee && !counts) pendingEarnedInRange += billableValue;
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
  // A split line counts for the company's part only, the same way employee
  // hours count for their margin (teamContribution) and not their full value.
  for (const line of serviceAccrualLines(fInvoices, input, pid => !filterActive || sel!.has(pid))) {
    const bucket = line.item.item_type === 'recurring' ? recurringByDayProject : fixedByDayProject;
    for (const [dk, dollars] of spreadLineItem(line.item, line.fallbackDate)) {
      if (dk < startKey || dk > endKey) continue;
      const vested = dollars * (1 - line.shareRatio) * dayVestingRatio(dk, now, timezone);
      if (vested <= 0) continue;
      if (!bucket.has(dk)) bucket.set(dk, new Map());
      const pmap = bucket.get(dk)!;
      pmap.set(line.projectId, (pmap.get(line.projectId) ?? 0) + vested);
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
    // Same eligibility as earned revenue: internal time is never owed, and
    // anyone but the owner is owed for only once their time is approved.
    const projectEntries = fTimeEntries.filter(te =>
      te.project_id === p.id &&
      te.work_type !== 'internal' &&
      (ownerMemberIds.has(te.member_id) || isApprovedTime(te)),
    );
    const isHourly = !!p.hourly_tracking;
    const rate = p.hourly_rate ?? 0;
    const pInvoicedByType = invoicedTotalsByItemType(pInvoicesAll);
    const pHourlyInvoiced = pInvoicedByType.hourly;
    const pNonHourlyOwed = pInvoicedByType.fixed + pInvoicedByType.recurring + pInvoicedByType.reimbursement;
    const pInvoicedTotal = pInvoicesAll.reduce((s, i) => s + i.amount, 0);
    const pBillable = isHourly
      ? Math.max(
          totalBillableAmount(
            projectEntries.map(te => ({
              id: te.id,
              hours: getWorkedHours(projectTimeEntryForBilling(te, now), now),
              hourly_rate: te.hourly_rate,
            })),
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
    earned, received, invoiced, outstanding, overdue, hours,
    pendingEarned: pendingEarnedInRange, activeInvoicesCount,
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

// Contributor attribution is additive to the established finance engine.
// It does not redefine `earned`, so Dashboard and Finances totals retain their
// existing contract while the new UI can explain who produced the value.
export type FinanceAttributionSource = 'owner' | 'human' | 'agent' | 'business';
export type FinanceCostTracking = 'tracked' | 'not_tracked';

export interface FinanceAttributionRow {
  id: string;
  name: string;
  source: FinanceAttributionSource;
  memberId: string | null;
  grossRevenue: number;
  recordedCost: number | null;
  contribution: number | null;
  hours: number;
  costTracking: FinanceCostTracking;
}

export interface FinanceAttributionData {
  rows: FinanceAttributionRow[];
  grossRevenue: number;
  recordedCost: number | null;
  contribution: number | null;
  hours: number;
  costTracking: FinanceCostTracking;
}

export interface FinanceAttributionInput extends FinanceEngineInput {
  /** A present key, including a zero value, means usage cost is tracked. */
  agentUsageCostByMember?: ReadonlyMap<string, number>;
  selectedMemberIds?: Set<string>;
  selectedSources?: Set<FinanceAttributionSource>;
}

export function computeFinanceAttribution(input: FinanceAttributionInput): FinanceAttributionData {
  const { startKey, endKey } = input.range;
  const selectedProjects = input.selectedProjectIds;
  const projectIncluded = (projectId: string) => !selectedProjects?.size || selectedProjects.has(projectId);
  const memberIncluded = (memberId: string | null) => !input.selectedMemberIds?.size || (!!memberId && input.selectedMemberIds.has(memberId));
  const sourceIncluded = (source: FinanceAttributionSource) => !input.selectedSources?.size || input.selectedSources.has(source);
  const projectLookup = new Map(input.projects.map(project => [project.id, project]));
  const memberLookup = new Map(input.team.map(member => [member.id, member]));
  const mutableRows = new Map<string, FinanceAttributionRow>();

  const ensureMemberRow = (member: TeamMember): FinanceAttributionRow | null => {
    const source: FinanceAttributionSource = member.role === 'owner'
      ? 'owner'
      : member.role === 'agent'
        ? 'agent'
        : 'human';
    if (!memberIncluded(member.id) || !sourceIncluded(source)) return null;
    let row = mutableRows.get(member.id);
    if (!row) {
      const agentCostTracked = source !== 'agent' || input.agentUsageCostByMember?.has(member.id) === true;
      const cost = source === 'agent'
        ? (agentCostTracked ? Number(input.agentUsageCostByMember?.get(member.id) ?? 0) : null)
        : 0;
      row = {
        id: member.id,
        name: member.name,
        source,
        memberId: member.id,
        grossRevenue: 0,
        recordedCost: cost,
        contribution: cost === null ? null : -cost,
        hours: 0,
        costTracking: agentCostTracked ? 'tracked' : 'not_tracked',
      };
      mutableRows.set(member.id, row);
    }
    return row;
  };

  // Usage cost can exist in a range with no billable entry, such as an audit
  // or an idle scheduled check. Preserve that cost as a zero-revenue row.
  if (input.agentUsageCostByMember) {
    for (const member of input.team) {
      if (member.role === 'agent' && input.agentUsageCostByMember.has(member.id)) ensureMemberRow(member);
    }
  }

  for (const entry of input.timeEntries) {
    if (!projectIncluded(entry.project_id) || entry.work_type === 'internal') continue;
    const member = memberLookup.get(entry.member_id);
    if (!member) continue;
    // Same rule as computeFinanceData: whoever needs approving waits for it,
    // and the owner, who approves, does not wait for themselves.
    if (member.role !== 'owner' && entry.approval_status !== 'approved') continue;
    const row = ensureMemberRow(member);
    if (!row) continue;
    const project = projectLookup.get(entry.project_id);
    const rate = entry.hourly_rate ?? input.rateByProject.get(entry.project_id) ?? (project?.hourly_tracking ? project.hourly_rate ?? 0 : 0);
    const billingEntry = projectTimeEntryForBilling(entry, input.now);
    for (const [dateKey, workedHours] of getWorkedHoursByDay(billingEntry, input.now)) {
      if (dateKey < startKey || dateKey > endKey) continue;
      const revenue = workedHours * rate;
      const compensation = row.source === 'human'
        ? workedHours * Number(entry.compensation_rate || 0)
        : 0;
      row.hours += workedHours;
      row.grossRevenue += revenue;
      if (row.recordedCost !== null) row.recordedCost += compensation;
      if (row.contribution !== null) row.contribution += revenue - compensation;
    }
  }

  if (sourceIncluded('business') && !input.selectedMemberIds?.size) {
    let businessRevenue = 0;
    // What split members earn out of this revenue: cost of revenue, not margin.
    let businessShareCost = 0;
    for (const line of serviceAccrualLines(input.invoices, input, projectIncluded)) {
      for (const [dateKey, dollars] of spreadLineItem(line.item, line.fallbackDate)) {
        if (dateKey < startKey || dateKey > endKey) continue;
        const vested = dollars * dayVestingRatio(dateKey, input.now, input.timezone);
        businessRevenue += vested;
        businessShareCost += vested * line.shareRatio;
      }
    }
    mutableRows.set('business', {
      id: 'business',
      name: 'Business revenue',
      source: 'business',
      memberId: null,
      grossRevenue: businessRevenue,
      recordedCost: businessShareCost,
      contribution: businessRevenue - businessShareCost,
      hours: 0,
      costTracking: 'tracked',
    });
  }

  const rows = Array.from(mutableRows.values())
    .filter(row => row.grossRevenue !== 0 || row.recordedCost !== 0 || row.hours !== 0 || row.source === 'business')
    .sort((a, b) => b.grossRevenue - a.grossRevenue || a.name.localeCompare(b.name));
  const hasUntrackedCost = rows.some(row => row.costTracking === 'not_tracked');
  const grossRevenue = rows.reduce((sum, row) => sum + row.grossRevenue, 0);
  const recordedCost = hasUntrackedCost ? null : rows.reduce((sum, row) => sum + Number(row.recordedCost), 0);
  const contribution = hasUntrackedCost ? null : rows.reduce((sum, row) => sum + Number(row.contribution), 0);

  return {
    rows,
    grossRevenue,
    recordedCost,
    contribution,
    hours: rows.reduce((sum, row) => sum + row.hours, 0),
    costTracking: hasUntrackedCost ? 'not_tracked' : 'tracked',
  };
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
  // Revenue-split earnings land on the day the client paid. A reversed one
  // still counts; its clawback is the deduction written alongside it.
  const shareEarnings = (data.shareEarnings ?? []).filter(item => !item.voided_at);
  for (const earning of shareEarnings) {
    if (earning.earned_date < startKey || earning.earned_date > endKey) continue;
    earned += Number(earning.amount);
  }
  const allApproved = data.entries
    .filter(entry => entry.approval_status === 'approved')
    .reduce((sum, entry) => sum + [...getWorkedHoursByDay(entry).values()].reduce((s, v) => s + v, 0) * Number(entry.compensation_rate || 0), 0)
    + data.adjustments
      .filter(item => !item.voided_at)
      .reduce((sum, item) => sum + Number(item.amount) * (item.adjustment_type === 'deduction' ? -1 : 1), 0)
    + shareEarnings.reduce((sum, item) => sum + Number(item.amount), 0);
  const allocated = data.allocations.reduce((sum, allocation) => sum + Number(allocation.allocated_amount), 0);
  return { earned, owed: Math.max(0, allApproved - allocated) };
}
