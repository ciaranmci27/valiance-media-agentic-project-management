'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { getWorkedHours, getWorkedHoursByDay, getWorkedHoursByHour, isRunning } from '@/lib/time-entry-utils';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { ensureLineItems, invoicedTotalsByItemType, spreadLineItem, totalBillableAmount } from '@/lib/invoice-utils';
import Link from 'next/link';
import {
  DollarSign,
  TrendingUp,
  Receipt,
  FolderKanban,
  CalendarRange,
  ChevronDown,
  Check,
} from 'lucide-react';
import { PayrollPanel } from '@/components/finances/PayrollPanel';
import { EmployeeEarningsDashboard } from '@/components/finances/EmployeeEarningsDashboard';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import type { EmployeeEarningsData } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_EMPLOYEE_EARNINGS: EmployeeEarningsData = {
  entries: [],
  rates: [],
  adjustments: [],
  payouts: [],
  allocations: [],
};

function fmt(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function fmtCurrency(value: number): string {
  return value < 0 ? `-$${fmt(Math.abs(value))}` : `$${fmt(value)}`;
}

function fmtDate(dateStr: string, withWeekday = false): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const month = date.toLocaleString('en-US', { month: 'short' });
  const base = y !== now.getFullYear() ? `${month} ${d}, ${y}` : `${month} ${d}`;
  if (!withWeekday) return base;
  const weekday = date.toLocaleString('en-US', { weekday: 'short' });
  return `${weekday}, ${base}`;
}

/** YYYY-MM-DD from a Date in local time */
function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "12 AM" / "9 AM" / "12 PM" / "11 PM" — 12-hour clock label for an hour 0..23. */
function fmtHourLabel(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

/** Return ~4 nicely rounded tick values from 0 to ceiling */
function niceAxisTicks(maxVal: number, count = 4): number[] {
  if (maxVal <= 0) return [0];
  // Find a "nice" step: 1, 2, 5, 10, 20, 50, 100, 200, 500, ...
  const rawStep = maxVal / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / mag;
  let niceStep: number;
  if (residual <= 1.5) niceStep = 1 * mag;
  else if (residual <= 3.5) niceStep = 2 * mag;
  else if (residual <= 7.5) niceStep = 5 * mag;
  else niceStep = 10 * mag;

  const ticks: number[] = [0];
  let v = niceStep;
  while (v <= maxVal * 1.05) {
    ticks.push(v);
    v += niceStep;
  }
  // Always include a top tick that covers the max
  if (ticks[ticks.length - 1] < maxVal) ticks.push(v);
  return ticks;
}

/** Format axis label: $0, $500, $1K, $2.5K, etc. */
function fmtAxis(val: number): string {
  if (val === 0) return '$0';
  // Round to avoid floating-point artifacts like $0.600000000000001
  const rounded = Math.round(val * 100) / 100;
  const absolute = Math.abs(rounded);
  const prefix = rounded < 0 ? '-$' : '$';
  if (absolute >= 1000) return `${prefix}${(absolute / 1000).toFixed(absolute % 1000 === 0 ? 0 : 1)}K`;
  return `${prefix}${absolute}`;
}

// ---------------------------------------------------------------------------
// Date range presets
// ---------------------------------------------------------------------------

type RangePreset = '7d' | '30d' | '90d' | 'mtd' | 'ytd' | 'all' | 'custom';

const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

/** Resolve a preset to a [start, end] ISO date key pair (local time). */
function resolveRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  earliestDateKey: string | null,
  todayKey: string,
): { startKey: string; endKey: string } {
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const today = new Date(ty, tm - 1, td); // midnight local
  const endKey = todayKey;

  const makeStart = (daysBack: number): string => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    return toDateKey(d);
  };

  switch (preset) {
    case '7d': return { startKey: makeStart(6), endKey };
    case '30d': return { startKey: makeStart(29), endKey };
    case '90d': return { startKey: makeStart(89), endKey };
    case 'mtd': {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      return { startKey: toDateKey(d), endKey };
    }
    case 'ytd': {
      const d = new Date(today.getFullYear(), 0, 1);
      return { startKey: toDateKey(d), endKey };
    }
    case 'all': {
      // Fall back to 90 days if no historical data
      const start = earliestDateKey ?? makeStart(89);
      return { startKey: start, endKey };
    }
    case 'custom': {
      if (customStart && customEnd) {
        // Ensure start <= end
        return customStart <= customEnd
          ? { startKey: customStart, endKey: customEnd }
          : { startKey: customEnd, endKey: customStart };
      }
      return { startKey: makeStart(29), endKey };
    }
  }
}

/** Number of days (inclusive) between two date keys. */
function daysBetween(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const s = new Date(sy, sm - 1, sd);
  const e = new Date(ey, em - 1, ed);
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

/** Format a date range for display: "Apr 1 - Apr 13, 2026" */
function fmtRangeDisplay(startKey: string, endKey: string): string {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  const sameYear = sy === ey;
  const endYear = ey !== now.getFullYear() ? `, ${ey}` : '';
  if (sameYear) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${endYear}`;
  }
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  sent: 'bg-blue-50 text-blue-700',
  paid: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-zinc-100 text-zinc-400',
};

// ---------------------------------------------------------------------------
// Daily chart data type
// ---------------------------------------------------------------------------

interface DayProjectWork {
  projectId: string;
  projectName: string;
  color?: string;
  hours: number;
  value: number;   // hourly value (hours * rate)
  fixed: number;   // amortized fixed line-item revenue for this project on the day
  recurring: number; // amortized recurring line-item revenue for this project on the day
  teamContribution: number; // employee billable revenue minus employee compensation
}

interface DayBar {
  dateKey: string;         // YYYY-MM-DD (bucket start for week/month)
  endKey: string;          // bucket end (same as dateKey for 'day')
  label: string;           // axis label ("Mon 7", "Apr 1", "Apr")
  tooltipDate: string;     // formatted range for tooltip header
  hourlyValue: number;     // hours worked * project hourly rate
  hoursWorked: number;     // raw hours for the tooltip
  fixedRevenue: number;    // amortized fixed line items spread across their service period
  recurringRevenue: number;// amortized recurring line items spread across their service period
  paymentReceived: number; // sum of invoices with paid_date in this bucket
  teamContribution: number; // signed employee margin or internal labor cost
  projectWork: DayProjectWork[]; // per-project breakdown for tooltip
}

type Granularity = 'day' | 'week' | 'month';

/** Pick a chart granularity that keeps bar counts manageable. */
function pickGranularity(rangeDays: number): Granularity {
  if (rangeDays <= 90) return 'day';
  if (rangeDays <= 365) return 'week';
  return 'month';
}

/** Bucket-start key for a date at a given granularity. Weeks align to Monday. */
function bucketStartKey(dateKey: string, gran: Granularity): string {
  if (gran === 'day') return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  if (gran === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  const date = new Date(y, m - 1, d);
  const dow = date.getDay(); // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1;
  date.setDate(date.getDate() - back);
  return toDateKey(date);
}

/** Bucket-end key (last day in bucket). For 'week' = start + 6; for 'month' = last day of month. */
function bucketEndKey(startKey: string, gran: Granularity): string {
  if (gran === 'day') return startKey;
  const [y, m, d] = startKey.split('-').map(Number);
  if (gran === 'month') {
    const last = new Date(y, m, 0).getDate(); // day 0 of next month
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  }
  const end = new Date(y, m - 1, d);
  end.setDate(end.getDate() + 6);
  return toDateKey(end);
}

/** Short axis label for a bucket. */
function bucketAxisLabel(startKey: string, gran: Granularity, todayKey: string): string {
  const [y, m, d] = startKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (gran === 'day') {
    if (startKey === todayKey) return 'Today';
    return `${date.toLocaleDateString('en-US', { month: 'short' })} ${d}`;
  }
  if (gran === 'month') {
    const now = new Date();
    const base = date.toLocaleDateString('en-US', { month: 'short' });
    return y === now.getFullYear() ? base : `${base} ${String(y).slice(2)}`;
  }
  return `${date.toLocaleDateString('en-US', { month: 'short' })} ${d}`;
}

/** Tooltip header: "Mon, Apr 7" for day, "Apr 1 - Apr 7, 2026" for week, "April 2026" for month. */
function bucketTooltipLabel(startKey: string, endKey: string, gran: Granularity): string {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  if (gran === 'day') return fmtDate(startKey, true);
  if (gran === 'month') {
    const full = start.toLocaleDateString('en-US', { month: 'long' });
    return sy === now.getFullYear() ? full : `${full} ${sy}`;
  }
  const sameYear = sy === ey;
  const sameMonth = sameYear && sm === em;
  const startStr = sameYear
    ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const endStr = sameMonth
    ? `${ed}`
    : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const suffix = sameYear && ey !== now.getFullYear() ? `, ${ey}` : !sameYear ? `, ${ey}` : '';
  return `${startStr} - ${endStr}${suffix}`;
}

// ---------------------------------------------------------------------------
// Live tick indicator
// ---------------------------------------------------------------------------

/**
 * Small badge that signals the displayed numbers are ticking live. Renders
 * nothing when no timers are running. role="status" makes screen readers
 * announce when the count flips; motion-safe gates the ping for users with
 * prefers-reduced-motion.
 */
function LiveTickIndicator({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? 'timer' : 'timers'} running`;
  return (
    <Tooltip content={`${label} — numbers update every second`} className="ml-1">
      <span
        role="status"
        aria-label={`${label}. Numbers update live.`}
        className="inline-flex items-center gap-1.5 cursor-help"
      >
        <span className="relative inline-flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Live</span>
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FinancesPage() {
  const { projects, projectInvoices, timeEntries, team, employeeEarnings } = useApp();
  const { access } = useAuth();
  const canReadCompanyFinance = hasPermission(access, 'finance.company.read');
  const canReadOwnEarnings = hasPermission(access, 'earnings.own.read');

  // ── Live-tick clock for active timers ───────────────────────
  // While any entry is running, bump `now` once a second so the chart, totals,
  // and per-project rows tick up live. The 1Hz interval only mounts when
  // something is actually running, so idle pages don't churn renders.
  const [now, setNow] = useState(() => Date.now());
  const runningCount = useMemo(() => timeEntries.filter(isRunning).length, [timeEntries]);
  const hasRunningEntry = runningCount > 0;
  useEffect(() => {
    if (!hasRunningEntry) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunningEntry]);

  // Calendar day of `now`. Stable string so memos depending on it only rerun
  // when the day actually changes (not every second).
  const nowDayKey = toDateKey(new Date(now));

  // Roll the range and "today" label over at local midnight even when no
  // timer is running. One-shot timeout that re-arms each day; without this,
  // a page left open across midnight would keep showing yesterday's range.
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ms = tomorrow.getTime() - Date.now() + 250; // small buffer past midnight
    const id = window.setTimeout(() => setNow(Date.now()), ms);
    return () => clearTimeout(id);
  }, [nowDayKey]);

  // ── Date range state ────────────────────────────────────────
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeDropdownRef = useRef<HTMLDivElement>(null);

  // ── Project filter state ────────────────────────────────────
  // Empty set means "All projects" (no filter applied). Adding ids narrows
  // every metric on the page (chart, totals, project breakdown, invoice list)
  // to just those projects.
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const projectFilterDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rangeOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rangeDropdownRef.current && !rangeDropdownRef.current.contains(target)) {
        // Don't close if clicking inside a DateInput portal (rendered to body)
        const inPortal = (target as HTMLElement).closest?.('[role="dialog"][aria-label="Date picker"]');
        if (!inPortal) setRangeOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRangeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [rangeOpen]);

  // Same outside-click + Escape handling for the project filter dropdown.
  useEffect(() => {
    if (!projectFilterOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (projectFilterDropdownRef.current && !projectFilterDropdownRef.current.contains(target)) {
        setProjectFilterOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProjectFilterOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [projectFilterOpen]);

  // Build a lookup: project_id -> hourly_rate (0 if not hourly)
  const rateByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of projects) {
      map.set(p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0);
    }
    return map;
  }, [projects]);

  // Find earliest data point across invoices and time entries for "All time".
  // Respects the project filter so "All time" with a project selected starts
  // from that project's first data point rather than the workspace-wide one.
  const earliestDateKey = useMemo(() => {
    const includes = (id: string) => selectedProjectIds.size === 0 || selectedProjectIds.has(id);
    let earliest: string | null = null;
    for (const inv of projectInvoices) {
      if (!includes(inv.project_id)) continue;
      if (inv.date && (!earliest || inv.date < earliest)) earliest = inv.date;
    }
    for (const te of timeEntries) {
      if (!te.end_time) continue;
      if (!includes(te.project_id)) continue;
      const k = toDateKey(new Date(te.end_time));
      if (!earliest || k < earliest) earliest = k;
    }
    return earliest;
  }, [projectInvoices, timeEntries, selectedProjectIds]);

  const range = useMemo(
    // Passing nowDayKey makes the range re-resolve at local midnight, sliding
    // "Last 7 days" / "Last 30 days" / etc. forward without needing a refresh.
    () => resolveRange(preset, customStart, customEnd, earliestDateKey, nowDayKey),
    [preset, customStart, customEnd, earliestDateKey, nowDayKey],
  );

  const data = useMemo(() => {
    const { startKey, endKey } = range;

    // ── Project filter ─────────────────────────────────────
    // Empty selection = no filter (every project counts). When ids are
    // selected, every downstream loop reads from these filtered arrays so
    // chart bars, totals, project rows, and invoice lists all stay coherent.
    const projectFilterActive = selectedProjectIds.size > 0;
    const fProjects = projectFilterActive
      ? projects.filter(p => selectedProjectIds.has(p.id))
      : projects;
    const fInvoices = projectFilterActive
      ? projectInvoices.filter(i => selectedProjectIds.has(i.project_id))
      : projectInvoices;
    const fTimeEntries = projectFilterActive
      ? timeEntries.filter(t => selectedProjectIds.has(t.project_id))
      : timeEntries;

    // ── Range-aware invoice / payment filters ──────────────
    const invoicesInRange = fInvoices.filter(inv => inv.date >= startKey && inv.date <= endKey);
    const activeInvoices = invoicesInRange.filter(inv => inv.status !== 'cancelled');
    // Cash actually received during the range (by paid_date), regardless of when the invoice was issued
    const paymentsInRange = fInvoices.filter(
      inv => inv.status === 'paid' && inv.paid_date && inv.paid_date >= startKey && inv.paid_date <= endKey,
    );
    // Overdue is a current-state snapshot, not a period stat — count all overdue invoices
    const totalOverdue = fInvoices
      .filter(inv => inv.status === 'overdue')
      .reduce((s, i) => s + i.amount, 0);

    const totalInvoiced = activeInvoices.reduce((s, i) => s + i.amount, 0);
    const totalPaymentsReceived = paymentsInRange.reduce((s, i) => s + i.amount, 0);
    const activeInvoicesCount = activeInvoices.length;

    // ── Hours fragmented by calendar day ───────────────────
    // Each entry is split per local calendar day so a session crossing midnight
    // credits both days proportionally (e.g. 8pm to 1am = 4h on the start day,
    // 1h on the next). The chart (workByDay), range totals (totalHours,
    // hourlyEarnedInRange), and per-project rows are all derived from the same
    // fragments in one pass so they stay coherent.
    const workByDay = new Map<string, Map<string, { hours: number; value: number; teamContribution: number }>>();
    const hoursByProjectInRange = new Map<string, number>();
    const hourlyEarnedByProjectInRange = new Map<string, number>();
    const teamContributionByProjectInRange = new Map<string, number>();
    const payableMemberIds = new Set(
      team.filter(member => member.role !== 'owner' && member.role !== 'agent').map(member => member.id),
    );
    let totalHours = 0;
    let hourlyEarnedInRange = 0;
    let teamContributionInRange = 0;

    for (const te of fTimeEntries) {
      // Stopped entries count permanently. Running entries tick against `now`.
      // Paused entries keep the time their closed segments already accumulated
      // (getWorkedHoursByDay sums closed segments either way), so revenue
      // doesn't flicker out the moment someone hits pause mid-session.
      const rate = te.hourly_rate ?? rateByProject.get(te.project_id) ?? 0;
      for (const [dayKey, hours] of getWorkedHoursByDay(te, now)) {
        if (dayKey < startKey || dayKey > endKey) continue;
        const billableValue = te.work_type === 'internal' ? 0 : hours * rate;
        const isEmployee = payableMemberIds.has(te.member_id);
        const isApprovedEmployeeWork = isEmployee && te.approval_status === 'approved';
        const value = isEmployee ? 0 : billableValue;
        const teamContribution = isApprovedEmployeeWork
          ? billableValue - (hours * Number(te.compensation_rate || 0))
          : 0;
        totalHours += hours;
        hourlyEarnedInRange += value;
        teamContributionInRange += teamContribution;
        hoursByProjectInRange.set(te.project_id, (hoursByProjectInRange.get(te.project_id) ?? 0) + hours);
        hourlyEarnedByProjectInRange.set(
          te.project_id,
          (hourlyEarnedByProjectInRange.get(te.project_id) ?? 0) + value,
        );
        teamContributionByProjectInRange.set(
          te.project_id,
          (teamContributionByProjectInRange.get(te.project_id) ?? 0) + teamContribution,
        );
        let dayMap = workByDay.get(dayKey);
        if (!dayMap) {
          dayMap = new Map();
          workByDay.set(dayKey, dayMap);
        }
        const cur = dayMap.get(te.project_id) ?? { hours: 0, value: 0, teamContribution: 0 };
        cur.hours += hours;
        cur.value += value;
        cur.teamContribution += teamContribution;
        dayMap.set(te.project_id, cur);
      }
    }

    // Collection rate: lifetime "money in hand" vs "money owed" snapshot.
    // = all-time received / (all-time received + currently outstanding)
    // Date-selector independent (matches Outstanding's all-time framing).
    const totalReceivedAllTime = fInvoices
      .filter(inv => inv.status === 'paid')
      .reduce((s, i) => s + i.amount, 0);

    // ── Daily chart ─────────────────────────────────────────
    // Derive from `now` (already a dep) so the "Today" axis label rolls over
    // at midnight on the same tick the range slides forward.
    const todayKey = toDateKey(new Date(now));

    // Pre-index: payments received per day (uses paid_date, range-scoped)
    // Note: this uses paid_date independently of the invoice date filter,
    // so the chart reflects actual cash flow on each day.
    const paymentsByDay = new Map<string, number>();
    for (const inv of fInvoices) {
      if (inv.status !== 'paid' || !inv.paid_date) continue;
      if (inv.paid_date < startKey || inv.paid_date > endKey) continue;
      paymentsByDay.set(inv.paid_date, (paymentsByDay.get(inv.paid_date) ?? 0) + inv.amount);
    }

    // Pre-index: amortized fixed and recurring line-item revenue per day, broken
    // down by project. Each service revenue line item is spread across its
    // period (or falls on the invoice date when no service window is set).
    // Hourly and reimbursement line items are ignored here.
    const fixedByDayProject = new Map<string, Map<string, number>>();
    const recurringByDayProject = new Map<string, Map<string, number>>();
    for (const inv of fInvoices) {
      if (inv.status === 'cancelled') continue;
      for (const li of ensureLineItems(inv)) {
        if (li.item_type === 'hourly' || li.item_type === 'reimbursement') continue;
        const bucket = li.item_type === 'recurring' ? recurringByDayProject : fixedByDayProject;
        const spread = spreadLineItem(li, inv.date);
        for (const [dk, dollars] of spread) {
          if (dk < startKey || dk > endKey) continue;
          if (!bucket.has(dk)) bucket.set(dk, new Map());
          const pmap = bucket.get(dk)!;
          pmap.set(inv.project_id, (pmap.get(inv.project_id) ?? 0) + dollars);
        }
      }
    }

    // Lookup for project names/colors. Filtered set keeps tooltip rows tied
    // to currently-visible projects only.
    const projectLookup = new Map(fProjects.map(p => [p.id, p]));

    // Build bar array across the range. Pick a granularity (day/week/month)
    // based on span so very wide ranges don't produce hundreds of hairline bars.
    const rangeDays = daysBetween(startKey, endKey);
    const granularity = pickGranularity(rangeDays);
    const [sy, sm, sd] = startKey.split('-').map(Number);
    const startDate = new Date(sy, sm - 1, sd);

    // Bucket accumulator keyed by bucket start date
    interface BucketAgg {
      startKey: string;
      endKey: string;
      hours: number;
      hourly: number;
      fixed: number;
      recurring: number;
      payments: number;
      teamContribution: number;
      projects: Map<string, { hours: number; value: number; fixed: number; recurring: number; teamContribution: number }>;
    }
    const buckets = new Map<string, BucketAgg>();
    const getBucket = (dk: string): BucketAgg => {
      const bStart = bucketStartKey(dk, granularity);
      let b = buckets.get(bStart);
      if (!b) {
        // Clamp bucket end to range end so partial weeks/months don't overstate span
        const rawEnd = bucketEndKey(bStart, granularity);
        const clampedEnd = rawEnd > endKey ? endKey : rawEnd;
        // Also clamp start up to range start (for the first bucket when week/month
        // begins before the selected range).
        const clampedStart = bStart < startKey ? startKey : bStart;
        b = {
          startKey: clampedStart,
          endKey: clampedEnd,
          hours: 0, hourly: 0, fixed: 0, recurring: 0, payments: 0, teamContribution: 0,
          projects: new Map(),
        };
        buckets.set(bStart, b);
      }
      return b;
    };
    const mergeProject = (b: BucketAgg, pid: string, delta: { hours?: number; value?: number; fixed?: number; recurring?: number; teamContribution?: number }) => {
      const cur = b.projects.get(pid) ?? { hours: 0, value: 0, fixed: 0, recurring: 0, teamContribution: 0 };
      cur.hours += delta.hours ?? 0;
      cur.value += delta.value ?? 0;
      cur.fixed += delta.fixed ?? 0;
      cur.recurring += delta.recurring ?? 0;
      cur.teamContribution += delta.teamContribution ?? 0;
      b.projects.set(pid, cur);
    };

    // Walk every day in the range so empty buckets still get created (keeps
    // the x-axis continuous).
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dk = toDateKey(d);
      const b = getBucket(dk);

      const dayProjects = workByDay.get(dk);
      if (dayProjects) {
        for (const [pid, w] of dayProjects) {
          b.hours += w.hours;
          b.hourly += w.value;
          b.teamContribution += w.teamContribution;
          mergeProject(b, pid, { hours: w.hours, value: w.value, teamContribution: w.teamContribution });
        }
      }
      const dayFixed = fixedByDayProject.get(dk);
      if (dayFixed) {
        for (const [pid, dollars] of dayFixed) {
          b.fixed += dollars;
          mergeProject(b, pid, { fixed: dollars });
        }
      }
      const dayRecurring = recurringByDayProject.get(dk);
      if (dayRecurring) {
        for (const [pid, dollars] of dayRecurring) {
          b.recurring += dollars;
          mergeProject(b, pid, { recurring: dollars });
        }
      }
      const dayPayment = paymentsByDay.get(dk);
      if (dayPayment) b.payments += dayPayment;
    }

    const dailyBars: DayBar[] = Array.from(buckets.values())
      .sort((a, b) => a.startKey.localeCompare(b.startKey))
      .map(b => {
        const projectWork: DayProjectWork[] = Array.from(b.projects.entries())
          .map(([pid, w]) => {
            const proj = projectLookup.get(pid);
            return {
              projectId: pid,
              projectName: proj?.name ?? 'Unknown',
              color: proj?.color,
              hours: w.hours,
              value: w.value,
              fixed: w.fixed,
              recurring: w.recurring,
              teamContribution: w.teamContribution,
            };
          })
          .sort((a, b) => (b.value + b.fixed + b.recurring) - (a.value + a.fixed + a.recurring));
        return {
          dateKey: b.startKey,
          endKey: b.endKey,
          label: bucketAxisLabel(b.startKey, granularity, todayKey),
          tooltipDate: bucketTooltipLabel(b.startKey, b.endKey, granularity),
          hourlyValue: b.hourly,
          hoursWorked: b.hours,
          fixedRevenue: b.fixed,
          recurringRevenue: b.recurring,
          paymentReceived: b.payments,
          teamContribution: b.teamContribution,
          projectWork,
        };
      });

    // Max bar height = max(hourly + fixed + recurring + payment) across the range
    const maxBarTotal = Math.max(
      ...dailyBars.map(d => d.hourlyValue + d.fixedRevenue + d.recurringRevenue + d.paymentReceived + Math.max(0, d.teamContribution)),
      1,
    );

    // Range-scoped totals derived from the daily bars (so Earned matches the chart)
    const totalAccruedInRange = dailyBars.reduce((s, d) => s + d.fixedRevenue + d.recurringRevenue, 0);
    const totalEarned = hourlyEarnedInRange + totalAccruedInRange + teamContributionInRange;

    // ── Per-project outstanding (all-time, current snapshot) ─
    // Outstanding is a current-state stat (what's still owed right now), so it's
    // computed from all-time invoices and time entries — NOT date-filtered.
    // Same formula as the project details InvoicesPanel:
    //   hourly:     max(0, max(rate * hours, hourlyInvoiced) + nonHourlyOwed - paid)
    //   non-hourly: max(0, invoiced - paid)
    const outstandingByProject = new Map<string, number>();
    for (const p of fProjects) {
      if (p.status === 'archived') continue;
      const pInvoicesAll = fInvoices.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
      const pPaidAll = fInvoices
        .filter(inv => inv.project_id === p.id && inv.status === 'paid')
        .reduce((s, i) => s + i.amount, 0);
      // Stopped entries count permanently, running entries tick against `now`,
      // paused entries keep their accumulated time (getWorkedHours sums closed
      // segments). All three states contribute so Outstanding stays stable
      // across pause/resume and clock-out transitions.
      const projectEntries = fTimeEntries.filter(te => te.project_id === p.id);
      const isHourly = !!p.hourly_tracking;
      const rate = p.hourly_rate ?? 0;
      // Aggregate line-item amounts by type across all active invoices.
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
    const totalOutstanding = Array.from(outstandingByProject.values()).reduce((s, v) => s + v, 0);

    // Collection rate (lifetime snapshot): % of total billable that's been received.
    // Independent of date selector — pairs with Outstanding which is also all-time.
    const collectionDenom = totalReceivedAllTime + totalOutstanding;
    const collectionRate = collectionDenom > 0
      ? Math.round((totalReceivedAllTime / collectionDenom) * 100)
      : 0;

    // ── Per-project breakdown (range-scoped) ─────────────────
    // Per-project accrued total in range (from amortized spread).
    const accruedByProjectInRange = new Map<string, number>();
    for (const bucket of [fixedByDayProject, recurringByDayProject]) {
      for (const [, pmap] of bucket) {
        for (const [pid, dollars] of pmap) {
          accruedByProjectInRange.set(pid, (accruedByProjectInRange.get(pid) ?? 0) + dollars);
        }
      }
    }

    const projectBreakdown = fProjects
      .filter(p => p.status !== 'archived')
      .map(p => {
        const pInvoices = invoicesInRange.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
        const pPayments = paymentsInRange.filter(inv => inv.project_id === p.id);
        // Hours and hourly-earned come from the per-day fragment pass so they
        // match the chart (a session that crosses midnight is split by day).
        const pHours = hoursByProjectInRange.get(p.id) ?? 0;
        const pHourlyEarned = hourlyEarnedByProjectInRange.get(p.id) ?? 0;
        const pTeamContribution = teamContributionByProjectInRange.get(p.id) ?? 0;
        const pAccrued = accruedByProjectInRange.get(p.id) ?? 0;
        const pEarned = pHourlyEarned + pAccrued + pTeamContribution;

        return {
          id: p.id,
          name: p.name,
          color: p.color,
          hourlyRate: p.hourly_rate,
          isHourly: !!p.hourly_tracking,
          invoiced: pInvoices.reduce((s, i) => s + i.amount, 0),
          earned: pEarned,
          received: pPayments.reduce((s, i) => s + i.amount, 0),
          // Outstanding column shows all-time outstanding (current snapshot)
          outstanding: outstandingByProject.get(p.id) ?? 0,
          hours: pHours,
        };
      })
      .filter(p => p.invoiced > 0 || p.hours > 0 || p.outstanding > 0 || Math.abs(p.earned) > 0.005)
      .sort((a, b) => b.earned - a.earned);

    // ── Invoices in range (sorted newest first) ─────────────
    const allInvoices = [...invoicesInRange]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      totalInvoiced, totalEarned, totalPaymentsReceived, totalOutstanding, totalOverdue,
      totalHours, collectionRate, activeInvoicesCount,
      dailyBars, maxBarTotal, granularity,
      projectBreakdown, allInvoices,
      // Exposed for bucket drilldown (week/month → days). Each map is keyed by
      // YYYY-MM-DD and contains the per-day data already used to build
      // dailyBars; the drilldown just re-aggregates those days at day
      // granularity without redoing the time-entry / invoice scans.
      workByDay, fixedByDayProject, recurringByDayProject, paymentsByDay, projectLookup,
    };
  }, [projects, projectInvoices, timeEntries, team, rateByProject, range, now, selectedProjectIds]);

  // ── Chart state & constants ────────────────────────────────
  const [showHourly, setShowHourly] = useState(true);
  const [showRecurring, setShowRecurring] = useState(true);
  const [showFixed, setShowFixed] = useState(true);
  const [showTeam, setShowTeam] = useState(true);
  const [showPayments, setShowPayments] = useState(true);
  const [selectedBar, setSelectedBar] = useState<string | null>(null);
  // Drilldown is a two-level stack on top of the main range view:
  //   - drilldownBucket: a [startKey, endKey] window (set when the user clicks
  //     a week/month bar). The chart then shows day-granularity bars inside it.
  //   - drilldownDay: a single YYYY-MM-DD (set when the user clicks a day bar,
  //     either from the main range at day-granularity or from a bucket view).
  //     The chart then shows 24 hour-granularity bars for that day.
  // Both null = main range view. Only `drilldownDay` set = drilled straight
  // from a day-granularity main view. Both set = drilled bucket → day → hour.
  const [drilldownBucket, setDrilldownBucket] = useState<{ startKey: string; endKey: string } | null>(null);
  const [drilldownDay, setDrilldownDay] = useState<string | null>(null);
  const [togglesLoaded, setTogglesLoaded] = useState(false);

  // Exit drilldown when the user changes the range OR the project filter —
  // the drilled level might no longer be relevant under the new scope.
  // Derived-from-props pattern: compare against the last filter snapshot
  // and reset during render rather than in an effect (effect form triggers
  // React's set-state-in-effect lint).
  const filterKey = `${range.startKey}_${range.endKey}_${[...selectedProjectIds].sort().join(',')}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setDrilldownDay(null);
    setDrilldownBucket(null);
    setSelectedBar(null);
  }

  // Restore toggle state from localStorage on mount
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      try {
        const raw = localStorage.getItem('finances:chartToggles');
        if (raw) {
          const saved = JSON.parse(raw);
          if (typeof saved.hourly === 'boolean') setShowHourly(saved.hourly);
          if (typeof saved.recurring === 'boolean') setShowRecurring(saved.recurring);
          if (typeof saved.fixed === 'boolean') setShowFixed(saved.fixed);
          if (typeof saved.team === 'boolean') setShowTeam(saved.team);
          if (typeof saved.payments === 'boolean') setShowPayments(saved.payments);
        }
      } catch {
        // ignore malformed storage
      }
      setTogglesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  // Persist toggle state whenever it changes (after initial load)
  useEffect(() => {
    if (!togglesLoaded) return;
    try {
      localStorage.setItem(
        'finances:chartToggles',
        JSON.stringify({
          hourly: showHourly,
          recurring: showRecurring,
          fixed: showFixed,
          team: showTeam,
          payments: showPayments,
        }),
      );
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [togglesLoaded, showHourly, showRecurring, showFixed, showTeam, showPayments]);
  // Chart height is flex-driven (min 160px), bars use percentage heights

  // ── Bucket drilldown bars (week/month → days) ──────────────
  // When the user clicks a week or month bar, we surface the days inside that
  // bucket as day-granularity bars. Reuses the per-day maps already built by
  // the `data` useMemo so we don't re-scan time entries or invoices — just
  // pluck out the days in the bucket window and shape them into DayBar[].
  const bucketDayBars = useMemo<DayBar[] | null>(() => {
    if (!drilldownBucket) return null;
    const { startKey, endKey } = drilldownBucket;
    const todayKey = toDateKey(new Date(now));
    const numDays = daysBetween(startKey, endKey);
    const [sy, sm, sd] = startKey.split('-').map(Number);
    const startDate = new Date(sy, sm - 1, sd);

    const bars: DayBar[] = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dk = toDateKey(d);

      const projectMap = new Map<string, { hours: number; value: number; fixed: number; recurring: number; teamContribution: number }>();
      const bumpProject = (pid: string, delta: { hours?: number; value?: number; fixed?: number; recurring?: number; teamContribution?: number }) => {
        const cur = projectMap.get(pid) ?? { hours: 0, value: 0, fixed: 0, recurring: 0, teamContribution: 0 };
        cur.hours += delta.hours ?? 0;
        cur.value += delta.value ?? 0;
        cur.fixed += delta.fixed ?? 0;
        cur.recurring += delta.recurring ?? 0;
        cur.teamContribution += delta.teamContribution ?? 0;
        projectMap.set(pid, cur);
      };

      let hours = 0, hourly = 0, fixed = 0, recurring = 0, teamContribution = 0;
      const dayWork = data.workByDay.get(dk);
      if (dayWork) {
        for (const [pid, w] of dayWork) {
          hours += w.hours;
          hourly += w.value;
          teamContribution += w.teamContribution;
          bumpProject(pid, { hours: w.hours, value: w.value, teamContribution: w.teamContribution });
        }
      }
      const dayFixed = data.fixedByDayProject.get(dk);
      if (dayFixed) {
        for (const [pid, dollars] of dayFixed) {
          fixed += dollars;
          bumpProject(pid, { fixed: dollars });
        }
      }
      const dayRecurring = data.recurringByDayProject.get(dk);
      if (dayRecurring) {
        for (const [pid, dollars] of dayRecurring) {
          recurring += dollars;
          bumpProject(pid, { recurring: dollars });
        }
      }
      const payments = data.paymentsByDay.get(dk) ?? 0;

      const projectWork: DayProjectWork[] = Array.from(projectMap.entries())
        .map(([pid, w]) => {
          const proj = data.projectLookup.get(pid);
          return {
            projectId: pid,
            projectName: proj?.name ?? 'Unknown',
            color: proj?.color,
            hours: w.hours,
            value: w.value,
            fixed: w.fixed,
            recurring: w.recurring,
            teamContribution: w.teamContribution,
          };
        })
        .sort((a, b) => (b.value + b.fixed + b.recurring) - (a.value + a.fixed + a.recurring));

      bars.push({
        dateKey: dk,
        endKey: dk,
        label: bucketAxisLabel(dk, 'day', todayKey),
        tooltipDate: bucketTooltipLabel(dk, dk, 'day'),
        hourlyValue: hourly,
        hoursWorked: hours,
        fixedRevenue: fixed,
        recurringRevenue: recurring,
        paymentReceived: payments,
        teamContribution,
        projectWork,
      });
    }
    return bars;
  }, [drilldownBucket, data, now]);

  // ── Hourly drilldown bars ──────────────────────────────────
  // When the user clicks a daily candle we surface a 24-bar view of that day,
  // one bar per local hour. Time worked splits at hour boundaries (a session
  // 9:45–10:15 contributes 15m to hour 9 and 15m to hour 10). Fixed and
  // recurring revenue have no inherent time-of-day, so the day's amortized
  // total for each is spread evenly across the 24 hours. Payments received on
  // the day get the same even spread.
  const hourlyBars = useMemo<DayBar[] | null>(() => {
    if (!drilldownDay) return null;

    interface HourBucket {
      hours: number;
      hourly: number;
      fixed: number;
      recurring: number;
      payments: number;
      teamContribution: number;
      projects: Map<string, { hours: number; value: number; fixed: number; recurring: number; teamContribution: number }>;
    }
    const buckets: HourBucket[] = Array.from({ length: 24 }, () => ({
      hours: 0, hourly: 0, fixed: 0, recurring: 0, payments: 0, teamContribution: 0, projects: new Map(),
    }));

    const bumpProject = (b: HourBucket, pid: string, delta: { hours?: number; value?: number; fixed?: number; recurring?: number; teamContribution?: number }) => {
      const cur = b.projects.get(pid) ?? { hours: 0, value: 0, fixed: 0, recurring: 0, teamContribution: 0 };
      cur.hours += delta.hours ?? 0;
      cur.value += delta.value ?? 0;
      cur.fixed += delta.fixed ?? 0;
      cur.recurring += delta.recurring ?? 0;
      cur.teamContribution += delta.teamContribution ?? 0;
      b.projects.set(pid, cur);
    };

    // Hourly work, split per local hour-of-day. Respects the page-level
    // project filter so the drilldown matches the parent chart.
    const includeProject = (id: string) =>
      selectedProjectIds.size === 0 || selectedProjectIds.has(id);
    const payableMemberIds = new Set(
      team.filter(member => member.role !== 'owner' && member.role !== 'agent').map(member => member.id),
    );
    for (const te of timeEntries) {
      if (!includeProject(te.project_id)) continue;
      const rate = te.hourly_rate ?? rateByProject.get(te.project_id) ?? 0;
      const perHour = getWorkedHoursByHour(te, drilldownDay, now);
      for (let h = 0; h < 24; h++) {
        const hours = perHour[h];
        if (hours <= 0) continue;
        const billableValue = te.work_type === 'internal' ? 0 : hours * rate;
        const isEmployee = payableMemberIds.has(te.member_id);
        const value = isEmployee ? 0 : billableValue;
        const teamContribution = isEmployee && te.approval_status === 'approved'
          ? billableValue - (hours * Number(te.compensation_rate || 0))
          : 0;
        buckets[h].hours += hours;
        buckets[h].hourly += value;
        buckets[h].teamContribution += teamContribution;
        bumpProject(buckets[h], te.project_id, { hours, value, teamContribution });
      }
    }

    // Fixed and recurring line items: take the day's amortized slice (same
    // spreadLineItem the daily chart uses), then divide by 24 for an even
    // distribution across the day.
    for (const inv of projectInvoices) {
      if (inv.status === 'cancelled') continue;
      if (!includeProject(inv.project_id)) continue;
      for (const li of ensureLineItems(inv)) {
        if (li.item_type === 'hourly' || li.item_type === 'reimbursement') continue;
        const dollarsThatDay = spreadLineItem(li, inv.date).get(drilldownDay) ?? 0;
        if (dollarsThatDay <= 0) continue;
        const perHourDollars = dollarsThatDay / 24;
        const isRecurring = li.item_type === 'recurring';
        for (let h = 0; h < 24; h++) {
          if (isRecurring) buckets[h].recurring += perHourDollars;
          else buckets[h].fixed += perHourDollars;
          bumpProject(buckets[h], inv.project_id, isRecurring ? { recurring: perHourDollars } : { fixed: perHourDollars });
        }
      }
    }

    // Payments received on this calendar day, spread evenly across the 24
    // hours. paid_date carries no time-of-day so per-hour attribution is a
    // visual convenience, not a claim about when the money arrived.
    let paymentsToday = 0;
    for (const inv of projectInvoices) {
      if (!includeProject(inv.project_id)) continue;
      if (inv.status === 'paid' && inv.paid_date === drilldownDay) paymentsToday += inv.amount;
    }
    if (paymentsToday > 0) {
      const perHourPayment = paymentsToday / 24;
      for (let h = 0; h < 24; h++) buckets[h].payments = perHourPayment;
    }

    const projectLookup = new Map(projects.map(p => [p.id, p]));
    return buckets.map((b, h) => {
      const projectWork: DayProjectWork[] = Array.from(b.projects.entries())
        .map(([pid, w]) => {
          const proj = projectLookup.get(pid);
          return {
            projectId: pid,
            projectName: proj?.name ?? 'Unknown',
            color: proj?.color,
            hours: w.hours,
            value: w.value,
            fixed: w.fixed,
            recurring: w.recurring,
            teamContribution: w.teamContribution,
          };
        })
        .sort((a, b) => (b.value + b.fixed + b.recurring) - (a.value + a.fixed + a.recurring));
      // dateKey must stay unique per bar (used as React key); embed the hour.
      const key = `${drilldownDay}T${String(h).padStart(2, '0')}`;
      return {
        dateKey: key,
        endKey: key,
        label: fmtHourLabel(h),
        tooltipDate: `${fmtHourLabel(h)} – ${fmtHourLabel((h + 1) % 24)}`,
        hourlyValue: b.hourly,
        hoursWorked: b.hours,
        fixedRevenue: b.fixed,
        recurringRevenue: b.recurring,
        paymentReceived: b.payments,
        teamContribution: b.teamContribution,
        projectWork,
      };
    });
  }, [drilldownDay, timeEntries, team, rateByProject, projectInvoices, projects, now, selectedProjectIds]);

  // What the chart actually renders, in priority order:
  //   hour drilldown → bucket drilldown → main range.
  const chartBars = hourlyBars ?? bucketDayBars ?? data.dailyBars;
  const isHourView = hourlyBars !== null;
  const isBucketView = !isHourView && bucketDayBars !== null;
  const isDrilledDown = isHourView || isBucketView;

  // Positive employee margin stacks with revenue. Internal or included-work
  // labor can be negative, so the chart reserves space below the zero line.
  const axisTicks = useMemo(() => {
    const positiveMax = Math.max(
      ...chartBars.map(d =>
        (showHourly ? d.hourlyValue : 0)
        + (showRecurring ? d.recurringRevenue : 0)
        + (showFixed ? d.fixedRevenue : 0)
        + (showPayments ? d.paymentReceived : 0)
        + (showTeam ? Math.max(0, d.teamContribution) : 0)),
      1,
    );
    const negativeMin = showTeam
      ? Math.min(...chartBars.map(d => Math.min(0, d.teamContribution)), 0)
      : 0;
    const positiveTicks = niceAxisTicks(positiveMax, negativeMin < 0 ? 3 : 4);
    if (negativeMin >= 0) return positiveTicks;
    const negativeTicks = niceAxisTicks(Math.abs(negativeMin), 2)
      .slice(1)
      .map(value => -value)
      .reverse();
    return [...negativeTicks, ...positiveTicks];
  }, [chartBars, showHourly, showRecurring, showFixed, showPayments, showTeam]);

  const axisMin = Math.min(0, axisTicks[0] || 0);
  const axisMax = Math.max(1, axisTicks[axisTicks.length - 1] || 1);
  const axisRange = axisMax - axisMin;
  const zeroBottomPct = Math.abs(axisMin) / axisRange * 100;
  const positiveAreaPct = axisMax / axisRange * 100;
  const negativeAreaPct = Math.abs(axisMin) / axisRange * 100;

  const hasAnyChartData = useMemo(
    () => chartBars.some(d => d.hourlyValue > 0 || d.fixedRevenue > 0 || d.recurringRevenue > 0 || d.paymentReceived > 0 || Math.abs(d.teamContribution) > 0.005),
    [chartBars],
  );

  // Track which categories have data so legend only shows relevant items
  const categoryHasData = useMemo(() => ({
    hourly: chartBars.some(d => d.hourlyValue > 0),
    recurring: chartBars.some(d => d.recurringRevenue > 0),
    fixed: chartBars.some(d => d.fixedRevenue > 0),
    payments: chartBars.some(d => d.paymentReceived > 0),
    team: chartBars.some(d => Math.abs(d.teamContribution) > 0.005),
  }), [chartBars]);

  if (!canReadCompanyFinance) {
    return <div className="animate-fadeIn min-h-screen bg-zinc-50"><Header title="My earnings" /><div className="p-4 lg:p-6">{canReadOwnEarnings ? <EmployeeEarningsDashboard projects={projects} data={employeeEarnings ?? EMPTY_EMPLOYEE_EARNINGS} /> : <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">You do not have access to financial information.</div>}</div></div>;
  }

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header title="Finances" />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {/* ── Overview + Date Filter ──────────────────────── */}
        <div className="bg-white rounded-xl border border-zinc-200">
          <div className="px-5 py-4 flex items-center justify-between gap-3 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <DollarSign size={18} className="text-zinc-500" />
              <h2 className="font-semibold text-zinc-900">Overview</h2>
              <LiveTickIndicator count={runningCount} />
            </div>

            <div className="flex items-center gap-2.5">
            <span className="hidden sm:inline text-xs text-zinc-400 font-medium">
              {fmtRangeDisplay(range.startKey, range.endKey)}
            </span>

            {/* Compact date range dropdown */}
            <div ref={rangeDropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setRangeOpen(o => !o)}
                aria-expanded={rangeOpen}
                aria-haspopup="menu"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 transition-colors"
              >
                <CalendarRange size={13} className="text-zinc-500" />
                <span className="text-xs font-medium text-zinc-700">
                  {PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom'}
                </span>
                <ChevronDown size={13} className={`text-zinc-400 transition-transform duration-150 ${rangeOpen ? 'rotate-180' : ''}`} />
              </button>

              {rangeOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden"
                >
                  <div className="p-1">
                    {PRESET_OPTIONS.map((opt) => {
                      const active = preset === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => {
                            setPreset(opt.value);
                            if (opt.value !== 'custom') setRangeOpen(false);
                          }}
                          className={`w-full text-left text-sm px-2.5 py-1.5 rounded-md transition-colors ${
                            active
                              ? 'bg-brand-50 text-brand-700 font-medium'
                              : 'text-zinc-700 hover:bg-zinc-50'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  {preset === 'custom' && (() => {
                    const todayKeyStr = toDateKey(new Date());
                    const startMin = earliestDateKey ?? undefined;
                    const startMax = customEnd && customEnd < todayKeyStr ? customEnd : todayKeyStr;
                    const endMin = customStart || earliestDateKey || undefined;
                    const endMax = todayKeyStr;
                    return (
                      <div className="border-t border-zinc-100 bg-zinc-50/50 p-3 space-y-2">
                        <DateInput
                          label="Start date"
                          value={customStart}
                          onChange={setCustomStart}
                          size="sm"
                          minDate={startMin}
                          maxDate={startMax}
                          clearable
                        />
                        <DateInput
                          label="End date"
                          value={customEnd}
                          onChange={setCustomEnd}
                          size="sm"
                          minDate={endMin}
                          maxDate={endMax}
                          clearable
                        />
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Project filter dropdown — same compact pattern as the date
                range dropdown. Empty selection = all projects (no filter). */}
            {(() => {
              // Show every non-archived project, sorted alphabetically for
              // predictable scanning. Archived projects can still match the
              // ids in the selection (if archived after selection) but aren't
              // listed here.
              const filterableProjects = projects
                .filter(p => p.status !== 'archived')
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
              const selectedCount = selectedProjectIds.size;
              const allSelectedOrNone = selectedCount === 0;
              const buttonLabel = allSelectedOrNone
                ? 'All projects'
                : selectedCount === 1
                  ? (projects.find(p => selectedProjectIds.has(p.id))?.name ?? '1 project')
                  : `${selectedCount} projects`;

              return (
                <div ref={projectFilterDropdownRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setProjectFilterOpen(o => !o)}
                    aria-expanded={projectFilterOpen}
                    aria-haspopup="menu"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 transition-colors"
                  >
                    <FolderKanban size={13} className="text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-700 truncate max-w-[140px]">{buttonLabel}</span>
                    {!allSelectedOrNone && (
                      <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 text-[9px] font-semibold text-white bg-brand-600 rounded-full">
                        {selectedCount}
                      </span>
                    )}
                    <ChevronDown size={13} className={`text-zinc-400 transition-transform duration-150 ${projectFilterOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {projectFilterOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden"
                    >
                      <div className="px-2.5 py-2 border-b border-zinc-100 flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                          Projects
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedProjectIds(new Set())}
                          disabled={allSelectedOrNone}
                          className="text-[11px] font-medium text-zinc-500 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto py-1">
                        {filterableProjects.length === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-zinc-400">No active projects</p>
                        ) : (
                          filterableProjects.map((p) => {
                            const checked = selectedProjectIds.has(p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={checked}
                                onClick={() => {
                                  setSelectedProjectIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(p.id)) next.delete(p.id);
                                    else next.add(p.id);
                                    return next;
                                  });
                                }}
                                className="w-full text-left text-sm px-2.5 py-1.5 hover:bg-zinc-50 transition-colors flex items-center gap-2"
                              >
                                <span
                                  className={`flex items-center justify-center w-4 h-4 rounded border transition-colors flex-shrink-0 ${
                                    checked
                                      ? 'bg-brand-600 border-brand-600 text-white'
                                      : 'border-zinc-300 bg-white'
                                  }`}
                                >
                                  {checked && <Check size={11} strokeWidth={3} />}
                                </span>
                                {p.color && (
                                  <span
                                    className="w-2 h-2 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: p.color }}
                                  />
                                )}
                                <span className="text-zinc-700 truncate flex-1 min-w-0">{p.name}</span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            </div>
          </div>

          <div className="px-5 py-3 overflow-x-auto">
            <div className="flex gap-6 lg:gap-8 min-w-max">
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Earned</p>
                <p className={`text-sm font-semibold ${data.totalEarned >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtCurrency(data.totalEarned)}</p>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Outstanding</p>
                <div className="flex items-center gap-1.5">
                  <p className={`text-sm font-semibold ${data.totalOutstanding > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>
                    ${fmt(data.totalOutstanding)}
                  </p>
                  {data.totalOverdue > 0 && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">
                      ${fmt(data.totalOverdue)} overdue
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Invoiced</p>
                <p className="text-sm font-semibold text-zinc-900">${fmt(data.totalInvoiced)}</p>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Received</p>
                <p className="text-sm font-semibold text-emerald-600">${fmt(data.totalPaymentsReceived)}</p>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Collected</p>
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-zinc-900">{data.collectionRate}%</p>
                  {data.collectionRate > 0 && (
                    <div className="w-16 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-400"
                        style={{ width: `${data.collectionRate}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Total Hours</p>
                <p className="text-sm font-semibold text-zinc-900">{data.totalHours.toFixed(1)}</p>
              </div>
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Invoices</p>
                <p className="text-sm font-semibold text-zinc-900">{data.activeInvoicesCount}</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Main Grid ───────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 items-stretch">

          {/* ── Daily Earnings Chart (2/3) ──────────────────── */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col min-h-[500px]">
            <div className="px-5 py-4 flex items-center justify-between border-b border-zinc-100 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <TrendingUp size={18} className="text-zinc-500 flex-shrink-0" />
                <h2 className="font-semibold text-zinc-900 truncate">
                  {isHourView
                    ? `Hourly Earnings · ${fmtDate(drilldownDay!, true)}`
                    : isBucketView
                      ? `Daily Earnings · ${fmtRangeDisplay(drilldownBucket!.startKey, drilldownBucket!.endKey)}`
                      : data.granularity === 'month' ? 'Monthly Earnings' : data.granularity === 'week' ? 'Weekly Earnings' : 'Daily Earnings'}
                </h2>
                <LiveTickIndicator count={runningCount} />
                {isDrilledDown && (
                  <button
                    type="button"
                    onClick={() => {
                      // Pop one level: hour → bucket (or main), bucket → main.
                      if (isHourView) setDrilldownDay(null);
                      else setDrilldownBucket(null);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors px-1.5 py-0.5 rounded hover:bg-zinc-50 flex-shrink-0"
                    aria-label="Back one level"
                  >
                    <ChevronDown size={14} className="rotate-90" />
                    Back
                  </button>
                )}
              </div>
              <span className="text-xs text-zinc-400 font-medium hidden sm:inline">
                {isHourView
                  ? 'Click bar to pin hour'
                  : isBucketView
                    ? 'Click a day to drill in'
                    : (PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range')}
              </span>
            </div>

            <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
              {(!showHourly && !showRecurring && !showFixed && !showTeam && !showPayments) ? (
                /* Empty state when both series are toggled off */
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                  <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                    <TrendingUp size={18} className="text-zinc-400" />
                  </div>
                  <p className="text-sm font-medium text-zinc-500">No data series selected</p>
                  <p className="text-xs text-zinc-400 mt-1">Toggle a legend below to view earnings data</p>
                </div>
              ) : !hasAnyChartData ? (
                /* Empty state when there's no data in the selected range */
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                  <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                    <TrendingUp size={18} className="text-zinc-400" />
                  </div>
                  <p className="text-sm font-medium text-zinc-500">No earnings in this range</p>
                  <p className="text-xs text-zinc-400 mt-1">Try a different date range or log some billable time</p>
                </div>
              ) : (
                <>
                  {/* Chart area with Y-axis */}
                  <div className="flex gap-0 flex-1 min-h-[160px]">
                    {/* Y-axis labels */}
                    <div className="flex flex-col justify-between flex-shrink-0 pr-2">
                      {[...axisTicks].reverse().map((tick) => (
                        <span
                          key={tick}
                          className="text-[10px] text-zinc-400 font-medium leading-none text-right"
                          style={{ minWidth: 36 }}
                        >
                          {fmtAxis(tick)}
                        </span>
                      ))}
                    </div>

                    {/* Bars + grid */}
                    <div className="flex-1 relative" onClick={() => setSelectedBar(null)}>
                      {/* Horizontal grid lines */}
                      {axisTicks.map((tick) => {
                        const pct = axisRange > 0 ? ((axisMax - tick) / axisRange) * 100 : 0;
                        return (
                          <div
                            key={`grid-${tick}`}
                            className={`absolute left-0 right-0 border-t ${tick === 0 && axisMin < 0 ? 'border-zinc-300' : 'border-zinc-100'}`}
                            style={{ top: `${pct}%` }}
                          />
                        );
                      })}

                      {/* Bars */}
                      <div className="flex items-end gap-[3px] relative z-[1] h-full">
                        {chartBars.map((day, barIdx) => {
                          const visibleHourly = showHourly ? day.hourlyValue : 0;
                          const visibleRecurring = showRecurring ? day.recurringRevenue : 0;
                          const visibleFixed = showFixed ? day.fixedRevenue : 0;
                          const visiblePayment = showPayments ? day.paymentReceived : 0;
                          const visibleTeam = showTeam ? day.teamContribution : 0;
                          const positiveTeam = Math.max(0, visibleTeam);
                          const negativeTeam = Math.min(0, visibleTeam);
                          const positiveTotal = visibleHourly + visibleRecurring + visibleFixed + visiblePayment + positiveTeam;
                          const hasData = positiveTotal > 0 || negativeTeam < -0.005;

                          const hourlyPct = axisMax > 0 ? (visibleHourly / axisMax) * 100 : 0;
                          const recurringPct = axisMax > 0 ? (visibleRecurring / axisMax) * 100 : 0;
                          const fixedPct = axisMax > 0 ? (visibleFixed / axisMax) * 100 : 0;
                          const paymentPct = axisMax > 0 ? (visiblePayment / axisMax) * 100 : 0;
                          const teamPositivePct = axisMax > 0 ? (positiveTeam / axisMax) * 100 : 0;
                          const teamNegativePct = axisMin < 0 ? (Math.abs(negativeTeam) / Math.abs(axisMin)) * 100 : 0;

                          const isSelected = selectedBar === day.dateKey;
                          // Drilldown ladder: week/month bar → bucket of days,
                          // day bar → 24 hours, hour bar → no further drill.
                          // Hour view bars only toggle their sticky tooltip.
                          const canDrillToBucket = !isDrilledDown && data.granularity !== 'day';
                          const canDrillToHour = !isHourView && (isBucketView || data.granularity === 'day');

                          // Figure out which segment is at the top so it gets rounded corners.
                          // Order top→bottom: payment, hourly, fixed, recurring.
                          const topIsPayment = visiblePayment > 0;
                          const topIsTeam = !topIsPayment && positiveTeam > 0;
                          const topIsHourly = !topIsPayment && !topIsTeam && visibleHourly > 0;
                          const topIsFixed = !topIsPayment && !topIsTeam && !topIsHourly && visibleFixed > 0;

                          return (
                            <div
                              key={day.dateKey}
                              className="flex-1 flex flex-col justify-end group relative h-full cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!hasData) {
                                  setSelectedBar(isSelected ? null : day.dateKey);
                                  return;
                                }
                                if (canDrillToBucket) {
                                  setDrilldownBucket({ startKey: day.dateKey, endKey: day.endKey });
                                  setSelectedBar(null);
                                  return;
                                }
                                if (canDrillToHour) {
                                  setDrilldownDay(day.dateKey);
                                  setSelectedBar(null);
                                  return;
                                }
                                setSelectedBar(isSelected ? null : day.dateKey);
                              }}
                            >
                              {hasData ? (
                                <>
                                  <div
                                    className="absolute inset-x-0 flex flex-col justify-end"
                                    style={{ bottom: `${zeroBottomPct}%`, height: `${positiveAreaPct}%` }}
                                  >
                                    {visiblePayment > 0 && <div className="w-full rounded-t bg-emerald-500 transition-colors duration-150 group-hover:bg-emerald-600" style={{ height: `${Math.max(paymentPct, 1.5)}%` }} />}
                                    {positiveTeam > 0 && <div className={`w-full bg-teal-500 transition-colors duration-150 group-hover:bg-teal-600 ${topIsTeam ? 'rounded-t' : ''}`} style={{ height: `${Math.max(teamPositivePct, 1.5)}%` }} />}
                                    {visibleHourly > 0 && <div className={`w-full bg-sky-400 transition-colors duration-150 group-hover:bg-sky-500 ${topIsHourly ? 'rounded-t' : ''}`} style={{ height: `${Math.max(hourlyPct, 1.5)}%` }} />}
                                    {visibleFixed > 0 && <div className={`w-full bg-violet-500 transition-colors duration-150 group-hover:bg-violet-600 ${topIsFixed ? 'rounded-t' : ''}`} style={{ height: `${Math.max(fixedPct, 1.5)}%` }} />}
                                    {visibleRecurring > 0 && <div className={`w-full bg-amber-400 transition-colors duration-150 group-hover:bg-amber-500 ${!topIsPayment && !topIsTeam && !topIsHourly && !topIsFixed ? 'rounded-t' : ''}`} style={{ height: `${Math.max(recurringPct, 1.5)}%` }} />}
                                  </div>
                                  {negativeTeam < 0 && (
                                    <div className="absolute inset-x-0" style={{ top: `${positiveAreaPct}%`, height: `${negativeAreaPct}%` }}>
                                      <div className="w-full rounded-b bg-rose-400 transition-colors duration-150 group-hover:bg-rose-500" style={{ height: `${Math.max(teamNegativePct, 2)}%` }} />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="absolute inset-x-0 bg-zinc-100" style={{ bottom: `${zeroBottomPct}%`, height: 2 }} />
                              )}

                              {/* Tooltip - anchored just above the bar, edge-aware */}
                              {(visibleHourly > 0 || visibleFixed > 0 || visibleRecurring > 0 || visiblePayment > 0 || Math.abs(visibleTeam) > 0.005) && (() => {
                                const barCount = chartBars.length;
                                // Use proportional thresholds so the tooltip flips to edge-anchored
                                // well before it would overflow the card. Tooltips can be wide
                                // (300+px), so center-align only for bars in the middle third.
                                const edgeZone = Math.max(4, Math.floor(barCount / 3));
                                const nearLeft = barIdx < edgeZone;
                                const nearRight = !nearLeft && barIdx >= barCount - edgeZone;
                                const alignCls = nearRight
                                  ? 'right-0'
                                  : nearLeft
                                    ? 'left-0'
                                    : 'left-1/2 -translate-x-1/2';
                                const visHourlyVal = showHourly ? day.hourlyValue : 0;
                                const visFixedVal = showFixed ? day.fixedRevenue : 0;
                                const visRecurringVal = showRecurring ? day.recurringRevenue : 0;
                                const visPaymentVal = showPayments ? day.paymentReceived : 0;
                                const visTeamVal = showTeam ? day.teamContribution : 0;
                                const totalEarnedDay = visHourlyVal + visFixedVal + visRecurringVal + visTeamVal;
                                const totalPct = axisRange > 0 ? (positiveTotal / axisRange) * 100 : 0;
                                // If the bar is too tall for the tooltip to fit above it,
                                // flip and anchor the tooltip to the top of the chart instead.
                                const flipBelow = totalPct > 65;
                                const posStyle: React.CSSProperties = flipBelow
                                  ? { top: 0 }
                                  : { bottom: `${Math.min(zeroBottomPct + totalPct, 95)}%` };
                                const spacingCls = flipBelow ? 'mt-1' : 'mb-1';
                                return (
                                <div className={`absolute ${spacingCls} z-10 pointer-events-none ${isSelected ? 'block' : 'hidden group-hover:block'} ${alignCls}`} style={posStyle}>
                                  {/* max-w caps width so long project names truncate inside the
                                      row instead of widening the tooltip. The body uses a
                                      flex-col layout with a flex-shrink-0 date header, a
                                      scrollable middle (when row count overflows max-h), and
                                      a flex-shrink-0 grand-total footer — so the user's
                                      anchors (which day, what's the day's total) stay visible
                                      no matter how many projects are on the bar. */}
                                  <div
                                    className="bg-zinc-900 text-white text-[10px] leading-relaxed px-2.5 py-1.5 rounded-md whitespace-nowrap shadow-lg max-w-[300px] max-h-[60vh] flex flex-col pointer-events-auto"
                                    /* Stop clicks on the tooltip body from bubbling up to the
                                       bar's onClick — otherwise tapping inside the tooltip
                                       (e.g. trying to scroll on mobile) would drill the bar
                                       or toggle its sticky state and hide the tooltip. */
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <p className="font-semibold text-zinc-200 mb-1 flex-shrink-0 truncate">{day.tooltipDate}</p>
                                    {day.projectWork.length > 0 && (() => {
                                      // Group by earning category (Hourly / Fixed / Recurring)
                                      // so each $ amount on a row maps to exactly one category —
                                      // no more "{hours}h $bundled-total" ambiguity. Single-
                                      // category days skip the category header to keep things
                                      // light; multi-category days surface the headers so the
                                      // visual hierarchy matches the math.
                                      type CategorySection = {
                                        key: 'hourly' | 'fixed' | 'recurring' | 'team';
                                        label: string;
                                        totalAmount: number;
                                        rows: { projectId: string; projectName: string; color?: string; hours?: number; amount: number }[];
                                      };
                                      const sections: CategorySection[] = [];

                                      if (showHourly && visHourlyVal > 0) {
                                        const rows = day.projectWork
                                          .filter(pw => pw.value > 0)
                                          .map(pw => ({
                                            projectId: pw.projectId,
                                            projectName: pw.projectName,
                                            color: pw.color,
                                            hours: pw.hours,
                                            amount: pw.value,
                                          }));
                                        if (rows.length > 0) {
                                          sections.push({ key: 'hourly', label: 'Hourly', totalAmount: visHourlyVal, rows });
                                        }
                                      }
                                      if (showFixed && visFixedVal > 0) {
                                        const rows = day.projectWork
                                          .filter(pw => pw.fixed > 0)
                                          .map(pw => ({ projectId: pw.projectId, projectName: pw.projectName, color: pw.color, amount: pw.fixed }));
                                        if (rows.length > 0) {
                                          sections.push({ key: 'fixed', label: 'Fixed', totalAmount: visFixedVal, rows });
                                        }
                                      }
                                      if (showRecurring && visRecurringVal > 0) {
                                        const rows = day.projectWork
                                          .filter(pw => pw.recurring > 0)
                                          .map(pw => ({ projectId: pw.projectId, projectName: pw.projectName, color: pw.color, amount: pw.recurring }));
                                        if (rows.length > 0) {
                                          sections.push({ key: 'recurring', label: 'Recurring', totalAmount: visRecurringVal, rows });
                                        }
                                      }
                                      if (showTeam && Math.abs(visTeamVal) > 0.005) {
                                        const rows = day.projectWork
                                          .filter(pw => Math.abs(pw.teamContribution) > 0.005)
                                          .map(pw => ({ projectId: pw.projectId, projectName: pw.projectName, color: pw.color, amount: pw.teamContribution }));
                                        if (rows.length > 0) {
                                          sections.push({ key: 'team', label: 'Team contribution', totalAmount: visTeamVal, rows });
                                        }
                                      }

                                      const isMultiCategory = sections.length > 1;
                                      const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
                                      // Only show totals when they actually summarize multiple
                                      // rows. A 1-row section's total just restates the row, and
                                      // a 1-row tooltip needs no grand total.
                                      const showGrandTotal = totalRows > 1;

                                      const renderProjectRow = (
                                        sectionKey: string,
                                        row: CategorySection['rows'][number],
                                        indent: boolean,
                                      ) => (
                                        <div key={`${sectionKey}-${row.projectId}`} className={`flex items-center gap-1.5 ${indent ? 'pl-2' : ''}`}>
                                          {row.color && (
                                            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.color }} />
                                          )}
                                          {/* flex-1 + min-w-0 + truncate lets a long project name
                                              ellipsize inside the tooltip's max-width. The hours
                                              and amount stay flex-shrink-0 so they're never the
                                              ones to lose width. */}
                                          <span className="text-zinc-400 flex-1 min-w-0 truncate" title={row.projectName}>{row.projectName}</span>
                                          {row.hours !== undefined && row.hours > 0 && (
                                            <span className="text-zinc-200 flex-shrink-0">{row.hours.toFixed(1)}h</span>
                                          )}
                                          <span className={`font-semibold flex-shrink-0 ${row.amount < 0 ? 'text-rose-300' : ''}`}>{fmtCurrency(row.amount)}</span>
                                        </div>
                                      );

                                      return (
                                        <div className="flex flex-col min-h-0 flex-1">
                                          {/* Scrollable middle — only this region scrolls when
                                              the project list overflows the tooltip's max-h. */}
                                          <div className="overflow-y-auto flex-1 min-h-0">
                                            {sections.map((section, idx) => (
                                              <div key={section.key} className={idx > 0 ? 'mt-1.5' : ''}>
                                                {isMultiCategory && (
                                                  <div className="flex items-baseline gap-1">
                                                    <span className="uppercase tracking-wider text-[9px] text-zinc-400 font-semibold">{section.label}</span>
                                                    {section.rows.length > 1 && (
                                                      <span className="text-[9px] text-zinc-300">({fmtCurrency(section.totalAmount)})</span>
                                                    )}
                                                  </div>
                                                )}
                                                <div className={`space-y-0.5 ${isMultiCategory ? 'mt-0.5' : ''}`}>
                                                  {section.rows.map(row => renderProjectRow(section.key, row, isMultiCategory))}
                                                </div>
                                              </div>
                                            ))}
                                          </div>

                                          {/* Pinned footer — flex-shrink-0 keeps it visible
                                              even when the body above is scrolling. */}
                                          {showGrandTotal && (
                                            <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center justify-between gap-3 text-zinc-100 flex-shrink-0">
                                              <span className="uppercase tracking-wider text-[9px] text-zinc-400">Total earned</span>
                                              <span className="font-semibold">{fmtCurrency(totalEarnedDay)}</span>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                    {visPaymentVal > 0 && (
                                      <p className="text-emerald-300 mt-0.5 flex-shrink-0">Payments: <span className="font-semibold">${fmt(visPaymentVal)}</span></p>
                                    )}
                                  </div>
                                </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Day labels - offset to align with bars (account for Y-axis width) */}
                  <div className="flex gap-[3px] mt-2" style={{ marginLeft: 44 }}>
                    {chartBars.map((day, i) => {
                      const total = chartBars.length;
                      // Hourly view has a known cadence: every 6 hours (12 AM,
                      // 6 AM, 12 PM, 6 PM). Bucket and range views aim for ~6
                      // labels regardless of bar count.
                      const labelStep = isHourView ? 6 : Math.max(1, Math.floor(total / 6));
                      const showLabel = isHourView
                        ? i % labelStep === 0
                        : i === 0 || i === total - 1 || i % labelStep === 0;
                      return (
                        <div key={`lbl-${day.dateKey}`} className="flex-1 text-center">
                          <span className="text-[9px] lg:text-[10px] text-zinc-400 font-medium truncate block">
                            {showLabel ? day.label : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Legend (toggleable) - only show categories that have data */}
              {(categoryHasData.hourly || categoryHasData.recurring || categoryHasData.fixed || categoryHasData.team || categoryHasData.payments) && (
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-zinc-100 flex-wrap">
                  {categoryHasData.hourly && (
                    <button
                      type="button"
                      onClick={() => setShowHourly(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showHourly ? 'bg-sky-50' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showHourly ? 'bg-sky-400' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-600 font-medium">Hourly</span>
                    </button>
                  )}
                  {categoryHasData.recurring && (
                    <button
                      type="button"
                      onClick={() => setShowRecurring(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showRecurring ? 'bg-amber-50' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showRecurring ? 'bg-amber-400' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-600 font-medium">Recurring</span>
                    </button>
                  )}
                  {categoryHasData.fixed && (
                    <button
                      type="button"
                      onClick={() => setShowFixed(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showFixed ? 'bg-violet-50' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showFixed ? 'bg-violet-500' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-600 font-medium">Fixed</span>
                    </button>
                  )}
                  {categoryHasData.team && (
                    <button
                      type="button"
                      onClick={() => setShowTeam(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showTeam ? 'bg-teal-50' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`flex w-2.5 h-2.5 overflow-hidden rounded-sm ${showTeam ? '' : 'bg-zinc-300'}`}>
                        {showTeam && <><span className="w-1/2 bg-teal-500" /><span className="w-1/2 bg-rose-400" /></>}
                      </div>
                      <span className="text-[11px] text-zinc-600 font-medium">Team contribution</span>
                    </button>
                  )}
                  {categoryHasData.payments && (
                    <button
                      type="button"
                      onClick={() => setShowPayments(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showPayments ? 'bg-emerald-50' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showPayments ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-600 font-medium">Payments</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Invoices (1/3) ──────────────────────── */}
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[500px]">
            <div className="px-5 py-4 flex items-center justify-between border-b border-zinc-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Receipt size={18} className="text-zinc-500" />
                <h2 className="font-semibold text-zinc-900">
                  Invoices
                  {data.allInvoices.length > 0 && (
                    <span className="ml-1.5 text-xs font-medium text-zinc-400">({data.allInvoices.length})</span>
                  )}
                </h2>
              </div>
              <span className="text-xs text-zinc-400 font-medium">{PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range'}</span>
            </div>

            {data.allInvoices.length > 0 ? (
              <div className="divide-y divide-zinc-100 flex-1 overflow-y-auto">
                {data.allInvoices.map((inv) => {
                  const project = projects.find(p => p.id === inv.project_id);
                  const items = ensureLineItems(inv);
                  const isMulti = items.length > 1;
                  const singleItemType = items[0]?.item_type;
                  return (
                    <Link
                      key={inv.id}
                      href={`/projects/${inv.project_id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-900">{inv.invoice_number}</span>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize ${STATUS_COLORS[inv.status] || ''}`}>
                            {inv.status}
                          </span>
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 capitalize">
                            {isMulti ? `${items.length} items` : (singleItemType ?? inv.invoice_type)}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5 truncate">{project?.name || 'Unknown project'}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-zinc-900">${fmt(inv.amount)}</p>
                        <p className="text-[11px] text-zinc-400">{fmtDate(inv.date)}</p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                  <Receipt size={18} className="text-zinc-400" />
                </div>
                <p className="text-sm font-medium text-zinc-500">No invoices in this range</p>
                <p className="text-xs text-zinc-400 mt-1">Try a different date range or create an invoice</p>
              </div>
            )}
          </div>
        </div>

        {/* ── Project Breakdown ────────────────────────────── */}
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col min-h-[260px]">
            <div className="px-5 py-4 flex items-center justify-between border-b border-zinc-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                <FolderKanban size={18} className="text-zinc-500" />
                <h2 className="font-semibold text-zinc-900">By Project</h2>
                <LiveTickIndicator count={runningCount} />
              </div>
              <span className="text-xs text-zinc-400 font-medium">{PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range'}</span>
            </div>

            {data.projectBreakdown.length > 0 ? (
              <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-2.5 text-[10px] uppercase tracking-wider font-medium text-zinc-400 border-b border-zinc-100">
                <span>Project</span>
                <span className="text-right w-24">Earned</span>
                <span className="text-right w-24">Received</span>
                <span className="text-right w-24">Invoiced</span>
                <span className="text-right w-24">Outstanding</span>
                <span className="text-right w-20">Hours</span>
              </div>

              <div className="divide-y divide-zinc-50">
                {data.projectBreakdown.map((p) => {
                  const receivedPct = p.earned > 0 ? (p.received / p.earned) * 100 : 0;
                  return (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-3.5 items-center hover:bg-zinc-50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {p.color && (
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                        )}
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-zinc-900 truncate block">{p.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <div className="w-16 h-1 bg-zinc-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full bg-emerald-400"
                                style={{ width: `${Math.min(receivedPct, 100)}%` }}
                              />
                            </div>
                            {p.isHourly && p.hourlyRate && (
                              <span className="text-[11px] text-zinc-400">${p.hourlyRate}/hr</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className={`text-sm font-semibold text-right w-24 ${p.earned >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtCurrency(p.earned)}</span>
                      <span className="text-sm text-emerald-700 font-semibold text-right w-24">${fmt(p.received)}</span>
                      <span className="text-sm text-zinc-700 font-medium text-right w-24">${fmt(p.invoiced)}</span>
                      <span className={`text-sm font-medium text-right w-24 ${p.outstanding > 0 ? 'text-amber-600' : 'text-zinc-300'}`}>
                        {p.outstanding > 0 ? `$${fmt(p.outstanding)}` : '-'}
                      </span>
                      <span className={`text-sm text-right w-20 ${p.hours > 0 ? 'text-violet-600 font-medium' : 'text-zinc-300'}`}>
                        {p.hours > 0 ? `${p.hours.toFixed(1)}h` : '-'}
                      </span>
                    </Link>
                  );
                })}
              </div>

              {/* Totals */}
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-3.5 border-t border-zinc-200 bg-zinc-50/50">
                <span className="text-sm font-semibold text-zinc-700">Total</span>
                <span className={`text-sm font-bold text-right w-24 ${data.totalEarned >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtCurrency(data.totalEarned)}</span>
                <span className="text-sm font-bold text-emerald-700 text-right w-24">${fmt(data.totalPaymentsReceived)}</span>
                <span className="text-sm font-bold text-zinc-900 text-right w-24">${fmt(data.totalInvoiced)}</span>
                <span className={`text-sm font-bold text-right w-24 ${data.totalOutstanding > 0 ? 'text-amber-600' : 'text-zinc-300'}`}>
                  {data.totalOutstanding > 0 ? `$${fmt(data.totalOutstanding)}` : '-'}
                </span>
                <span className="text-sm font-bold text-violet-600 text-right w-20">{data.totalHours.toFixed(1)}h</span>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-zinc-100">
              {data.projectBreakdown.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="block p-4 hover:bg-zinc-50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    {p.color && <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
                    <span className="text-sm font-medium text-zinc-900 truncate">{p.name}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">Earned</p>
                      <p className={`text-sm font-semibold ${p.earned >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmtCurrency(p.earned)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">Received</p>
                      <p className="text-sm font-semibold text-emerald-700">${fmt(p.received)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">Outstanding</p>
                      <p className={`text-sm font-semibold ${p.outstanding > 0 ? 'text-amber-600' : 'text-zinc-300'}`}>
                        {p.outstanding > 0 ? `$${fmt(p.outstanding)}` : '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">Hours</p>
                      <p className={`text-sm font-semibold ${p.hours > 0 ? 'text-violet-600' : 'text-zinc-300'}`}>
                        {p.hours > 0 ? `${p.hours.toFixed(1)}h` : '-'}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
                <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                  <FolderKanban size={18} className="text-zinc-400" />
                </div>
                <p className="text-sm font-medium text-zinc-500">No project activity in this range</p>
                <p className="text-xs text-zinc-400 mt-1">Projects with invoices or logged hours will appear here</p>
              </div>
            )}
          </div>
        <PayrollPanel team={team} projects={projects} />
      </div>
    </div>
  );
}
