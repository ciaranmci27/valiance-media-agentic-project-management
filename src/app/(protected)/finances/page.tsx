'use client';

import { Pill, sentenceCase, type PillTone } from '@/components/ui/Pill';
import { Suspense, useMemo, useState, useRef, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { getWorkedHoursByHour, isRunning } from '@/lib/time-entry-utils';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatStrip } from '@/components/ui/StatStrip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Popover } from '@/components/ui/Popover';
import { ensureLineItems, spreadLineItem } from '@/lib/invoice-utils';
import {
  computeFinanceData,
  computeFinanceAttribution,
  invoiceInCurrency,
  projectTimeEntryForBilling,
  serviceAccrualLines,
} from '@/lib/finance/summary';
import { useRetainerFinanceInputs } from '@/lib/finance/use-retainer-finance';
import { computeAgentAnalytics, trackedAgentUsageCostByMember } from '@/lib/agent-analytics';
import { toDateKey, localNextDayStartMs, hourVestingRatio } from '@/lib/finance/vesting';
import Link from 'next/link';
import {
  DollarSign,
  TrendingUp,
  Receipt,
  FolderKanban,
  CalendarRange,
  ChevronDown,
  Check,
  Users,
  CalendarClock,
} from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { PayrollPanel } from '@/components/finances/PayrollPanel';
import { TimesheetView } from '@/components/time/TimesheetView';
import { ProjectTabs, projectPanelId, projectTabId } from '@/components/projects/ProjectTabs';
import { Button } from '@/components/ui/Button';
import { FINANCE_TAB_LABELS, financeViews, type FinanceTab } from '@/lib/finance/finance-views';
import { EmployeeEarningsDashboard } from '@/components/finances/EmployeeEarningsDashboard';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import type { EmployeeEarningsData } from '@/lib/types';
import { toLocalDateKey } from '@/lib/date-utils';
import { excludedNote, formatHours } from '@/lib/format';
import { appLocale, startOfWeek, weekStartDay, type Region, type WeekStart } from '@/lib/region';
import { useMoney, useRegion } from '@/lib/region/context';
import { profileTimeZone } from '@/lib/time-zone';

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

/** "Apr 7", "Apr 7, 2025", "Mon, Apr 7" in en-US; the workspace locale's own order elsewhere. */
function fmtDate(dateStr: string, withWeekday = false, locale = appLocale()): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(locale, {
    ...(withWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}


/** "12 AM" / "9 AM" / "12 PM" / "11 PM" in en-US: an hour 0..23 on the workspace locale's clock. */
function fmtHourLabel(hour: number, locale = appLocale()): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(locale, { hour: 'numeric' });
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
function fmtRangeDisplay(startKey: string, endKey: string, locale = appLocale()): string {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  const day = { month: 'short', day: 'numeric' } as const;
  const dayYear = { month: 'short', day: 'numeric', year: 'numeric' } as const;
  if (sy === ey) {
    return `${start.toLocaleDateString(locale, day)} - ${end.toLocaleDateString(locale, ey !== now.getFullYear() ? dayYear : day)}`;
  }
  return `${start.toLocaleDateString(locale, dayYear)} - ${end.toLocaleDateString(locale, dayYear)}`;
}

const STATUS_TONE: Record<string, PillTone> = {
  draft: 'neutral',
  sent: 'info',
  paid: 'good',
  overdue: 'problem',
  cancelled: 'neutral',
};

// ---------------------------------------------------------------------------
// Earnings-source filter (attribution)
// ---------------------------------------------------------------------------

type EarningsSource = 'company' | 'business' | 'owner' | 'human' | 'agent' | 'member';

const SOURCE_OPTIONS: { value: Exclude<EarningsSource, 'member'>; label: string; hint: string }[] = [
  { value: 'company', label: 'Company', hint: 'Every contributor plus business revenue' },
  { value: 'business', label: 'Business', hint: 'Fixed and recurring accrued revenue' },
  { value: 'owner', label: 'Owner', hint: 'Owner billable time' },
  { value: 'human', label: 'Human team', hint: 'Approved billable value minus compensation' },
  { value: 'agent', label: 'AI agents', hint: 'Billable value minus tracked model cost' },
];

/** The one way a missing measurement renders. Never a fake zero. */
function NotTrackedValue({ reason, className = '' }: { reason: string; className?: string }) {
  return (
    <Tooltip content={<span className="block max-w-[260px] whitespace-normal">{reason}</span>}>
      <span className={`font-medium text-zinc-500 cursor-help ${className}`}>Not tracked</span>
    </Tooltip>
  );
}

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

/** Bucket-start key for a date at a given granularity. Weeks start on the workspace's first day. */
function bucketStartKey(dateKey: string, gran: Granularity, firstDay: WeekStart = weekStartDay()): string {
  if (gran === 'day') return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  if (gran === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  return toDateKey(startOfWeek(new Date(y, m - 1, d), firstDay));
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
function bucketAxisLabel(startKey: string, gran: Granularity, todayKey: string, locale = appLocale()): string {
  const [y, m, d] = startKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (gran === 'day') {
    if (startKey === todayKey) return 'Today';
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  if (gran === 'month') {
    const now = new Date();
    return date.toLocaleDateString(locale, y === now.getFullYear() ? { month: 'short' } : { month: 'short', year: '2-digit' });
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** Tooltip header: "Mon, Apr 7" for day, "Apr 1 - 7, 2026" for week, "April 2026" for month. */
function bucketTooltipLabel(startKey: string, endKey: string, gran: Granularity, locale = appLocale()): string {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  if (gran === 'day') return fmtDate(startKey, true, locale);
  if (gran === 'month') {
    return start.toLocaleDateString(locale, sy === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
  }
  const sameYear = sy === ey;
  const sameMonth = sameYear && sm === em;
  const startStr = sameYear
    ? start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    : start.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const endStr = sameMonth
    ? end.toLocaleDateString(locale, { day: 'numeric' })
    : end.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const suffix = sameYear && ey !== now.getFullYear() ? `, ${ey}` : !sameYear ? `, ${ey}` : '';
  return `${startStr} - ${endStr}${suffix}`;
}

// ---------------------------------------------------------------------------
// Live tick indicator
// ---------------------------------------------------------------------------

/**
 * Small badge that signals the displayed numbers are ticking live.
 */
function LiveTickIndicator({
  timerCount,
  fixedIncomeLive,
  recurringIncomeLive,
}: {
  timerCount: number;
  fixedIncomeLive: boolean;
  recurringIncomeLive: boolean;
}) {
  if (timerCount <= 0 && !fixedIncomeLive && !recurringIncomeLive) return null;
  const liveSources = [
    ...(timerCount > 0 ? [`${timerCount} hourly ${timerCount === 1 ? 'timer' : 'timers'}`] : []),
    ...(fixedIncomeLive ? ['fixed invoices'] : []),
    ...(recurringIncomeLive ? ['recurring invoices'] : []),
  ];
  const tooltip = `Live from ${liveSources.join(', ')}`;

  return (
    <Tooltip content={tooltip} className="ml-1">
      <span
        role="status"
        aria-label={tooltip}
        className="inline-flex items-center gap-1.5 cursor-help"
      >
        <span className="relative inline-flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs font-semibold text-emerald-400">Live</span>
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Bar building
// ---------------------------------------------------------------------------

// Turns one finance-engine pass into the chart's bar array. Shared by the
// company-wide pass and the source-scoped pass so both build identical bars.
function buildRangeBars(
  engine: ReturnType<typeof computeFinanceData>,
  range: { startKey: string; endKey: string },
  todayKey: string,
  region: Region,
): { dailyBars: DayBar[]; maxBarTotal: number; granularity: Granularity } {
  const { workByDay, fixedByDayProject, recurringByDayProject, paymentsByDay, projectLookup } = engine;
  const { startKey, endKey } = range;

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
    const bStart = bucketStartKey(dk, granularity, region.weekStart);
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
        label: bucketAxisLabel(b.startKey, granularity, todayKey, region.locale),
        tooltipDate: bucketTooltipLabel(b.startKey, b.endKey, granularity, region.locale),
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

  return { dailyBars, maxBarTotal, granularity };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * The company view (Client invoicing): revenue, the earnings chart, invoices
 * and the per-project breakdown, for people who read company finance.
 */
function CompanyOverview() {
  const { projects, projectInvoices, timeEntries, team, agentActivity } = useApp();
  const { access, teamMemberId } = useAuth();
  const region = useRegion();
  const money = useMoney();
  const canReadCompanyFinance = hasPermission(access, 'finance.company.read');
  // Agent cost and the AI agents lens belong to the agents module.
  const isAgentsEnabled = isModuleEnabled(access, 'agents');
  const currentMember = team.find(member => member.id === teamMemberId);
  const preferredTimezone = profileTimeZone(currentMember);

  // ── Live-tick clock for active timers ───────────────────────
  // Active timers and today's service revenue both depend on wall-clock time.
  // The 1Hz interval only mounts when something visible is changing.
  const [now, setNow] = useState(() => Date.now());
  const runningCount = useMemo(() => timeEntries.filter(isRunning).length, [timeEntries]);

  // Calendar day of `now`. Stable string so memos depending on it only rerun
  // when the day actually changes (not every second).
  const nowDayKey = toLocalDateKey(new Date(now).toISOString(), preferredTimezone);

  // Roll the range and "today" label over at the preferred-zone midnight even when no
  // timer is running. One-shot timeout that re-arms each day; without this,
  // a page left open across midnight would keep showing yesterday's range.
  useEffect(() => {
    const ms = localNextDayStartMs(nowDayKey, preferredTimezone) - Date.now() + 250;
    const id = window.setTimeout(() => setNow(Date.now()), ms);
    return () => clearTimeout(id);
  }, [nowDayKey, preferredTimezone]);

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

  // ── Earnings-source filter state ────────────────────────────
  // Re-scopes the chart and the Overview strip to one earnings source via a
  // second engine pass (see sourceData below). The Invoices card and By
  // Project stay company-wide: a payment belongs to a project, never to one
  // contributor.
  const [sourceFilter, setSourceFilter] = useState<EarningsSource>('company');
  const [sourceMemberId, setSourceMemberId] = useState<string | null>(null);
  const [sourceFilterOpen, setSourceFilterOpen] = useState(false);
  const sourceFilterDropdownRef = useRef<HTMLDivElement>(null);

  // Chart bars scroll horizontally on mobile (fixed ~30-bar window); the day
  // labels row mirrors that scroll so labels stay aligned to their bars.
  const chartBarsScrollRef = useRef<HTMLDivElement>(null);
  const chartLabelsScrollRef = useRef<HTMLDivElement>(null);

  // Invoice line splits and not-yet-invoiced retainer months, so the counter
  // shows the company's real take and keeps ticking for arrears retainers.
  // A cached read the boot load primed, one per local day; live sync
  // refreshes it as invoices and retainers change.
  const { lineSharePercent, accruingRetainerLines } = useRetainerFinanceInputs(canReadCompanyFinance);

  const liveServiceRevenue = useMemo(() => {
    const sources = { fixed: false, recurring: false };
    const lines = serviceAccrualLines(
      projectInvoices,
      { accruingRetainerLines },
      (projectId) => selectedProjectIds.size === 0 || selectedProjectIds.has(projectId),
    );

    for (const line of lines) {
      if ((spreadLineItem(line.item, line.fallbackDate).get(nowDayKey) ?? 0) <= 0) continue;
      sources[line.item.item_type as 'fixed' | 'recurring'] = true;
      if (sources.fixed && sources.recurring) return sources;
    }

    return sources;
  }, [projectInvoices, selectedProjectIds, nowDayKey, accruingRetainerLines]);

  const hasLiveServiceRevenue = liveServiceRevenue.fixed || liveServiceRevenue.recurring;
  const shouldLiveTick = runningCount > 0 || hasLiveServiceRevenue;
  useEffect(() => {
    if (!shouldLiveTick) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [shouldLiveTick]);

  // Outside-click + Escape for the range/project dropdowns is handled by the
  // portaled Popover component that renders each menu (see below).

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
      const k = toLocalDateKey(te.end_time, preferredTimezone);
      if (!earliest || k < earliest) earliest = k;
    }
    return earliest;
  }, [projectInvoices, timeEntries, selectedProjectIds, preferredTimezone]);

  const range = useMemo(
    // Passing nowDayKey makes the range re-resolve at local midnight, sliding
    // "Last 7 days" / "Last 30 days" / etc. forward without needing a refresh.
    () => resolveRange(preset, customStart, customEnd, earliestDateKey, nowDayKey),
    [preset, customStart, customEnd, earliestDateKey, nowDayKey],
  );

  const data = useMemo(() => {
    // All money rules come from the shared finance engine (single source of truth,
    // shared with the Dashboard). Bar building lives in buildRangeBars, shared
    // with the source-scoped pass below - no money logic lives here anymore.
    const engine = computeFinanceData({
      projects, invoices: projectInvoices, timeEntries, team, rateByProject,
      now, timezone: preferredTimezone, range, selectedProjectIds,
      lineSharePercent, accruingRetainerLines,
    });

    // ── Invoices in range (sorted newest first) ─────────────
    const allInvoices = [...engine.invoicesInRange]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      totalInvoiced: engine.invoiced,
      totalEarned: engine.earned,
      totalPaymentsReceived: engine.received,
      totalOutstanding: engine.outstanding,
      totalOverdue: engine.overdue,
      totalHours: engine.hours,
      totalPendingEarned: engine.pendingEarned,
      activeInvoicesCount: engine.activeInvoicesCount,
      excludedInvoices: engine.excludedInvoices,
      // "Today" axis labels roll over at local midnight (nowDayKey is timezone-aware).
      ...buildRangeBars(engine, range, nowDayKey, region),
      projectBreakdown: engine.projectBreakdown, allInvoices,
      // Exposed for bucket drilldown (week/month → days). Each map is keyed by
      // YYYY-MM-DD and contains the per-day data already used to build
      // dailyBars; the drilldown just re-aggregates those days at day
      // granularity without redoing the time-entry / invoice scans.
      workByDay: engine.workByDay,
      fixedByDayProject: engine.fixedByDayProject,
      recurringByDayProject: engine.recurringByDayProject,
      paymentsByDay: engine.paymentsByDay,
      projectLookup: engine.projectLookup,
    };
  }, [projects, projectInvoices, timeEntries, team, rateByProject, range, now, nowDayKey, preferredTimezone, selectedProjectIds, lineSharePercent, accruingRetainerLines, region]);

  // ── Earnings-source scoping ─────────────────────────────────
  // The source filter re-scopes the chart and the Overview strip through a
  // second engine pass over filtered inputs. People-sources get no invoices
  // at all: fixed/recurring accrual and payments belong to projects, never to
  // one contributor, so those series simply have no data (and the legend
  // hides them) instead of being force-toggled off. The raw `data` pass stays
  // company-wide for the Invoices card and By Project.
  const sourceMemberIds = useMemo<Set<string> | null>(() => {
    switch (sourceFilter) {
      case 'company': return null;
      case 'business': return new Set<string>();
      case 'owner': return new Set(team.filter(m => m.role === 'owner').map(m => m.id));
      // The human bucket must match computeFinanceAttribution's (any
      // non-owner, non-agent member, guests included) or the strip's cost and
      // contribution would disagree with the chart.
      case 'human': return new Set(team.filter(m => m.role !== 'owner' && m.role !== 'agent').map(m => m.id));
      case 'agent': return new Set(team.filter(m => m.role === 'agent').map(m => m.id));
      case 'member': return sourceMemberId ? new Set([sourceMemberId]) : null;
    }
  }, [team, sourceFilter, sourceMemberId]);

  const isPeopleSource = sourceFilter !== 'company' && sourceFilter !== 'business';
  const effectiveTimeEntries = useMemo(
    () => (sourceMemberIds === null ? timeEntries : timeEntries.filter(te => sourceMemberIds.has(te.member_id))),
    [timeEntries, sourceMemberIds],
  );
  const effectiveInvoices = useMemo(
    () => (isPeopleSource ? [] : projectInvoices),
    [isPeopleSource, projectInvoices],
  );
  const effectiveAccruingLines = useMemo(
    () => (isPeopleSource ? [] : accruingRetainerLines),
    [isPeopleSource, accruingRetainerLines],
  );

  const sourceData = useMemo(() => {
    if (sourceFilter === 'company') return null;
    const engine = computeFinanceData({
      projects, invoices: effectiveInvoices, timeEntries: effectiveTimeEntries, team, rateByProject,
      now, timezone: preferredTimezone, range, selectedProjectIds,
      lineSharePercent, accruingRetainerLines: effectiveAccruingLines,
    });
    return {
      totalEarned: engine.earned,
      totalHours: engine.hours,
      ...buildRangeBars(engine, range, nowDayKey, region),
      workByDay: engine.workByDay,
      fixedByDayProject: engine.fixedByDayProject,
      recurringByDayProject: engine.recurringByDayProject,
      paymentsByDay: engine.paymentsByDay,
      projectLookup: engine.projectLookup,
    };
  }, [sourceFilter, projects, effectiveInvoices, effectiveTimeEntries, team, rateByProject, now, nowDayKey, preferredTimezone, range, selectedProjectIds, lineSharePercent, effectiveAccruingLines, region]);

  // What the chart and drilldowns read from: the source-scoped pass when a
  // source is active, the company-wide pass otherwise.
  const chartData = sourceData ?? data;

  // ── Attribution (who produced the value) ────────────────────
  // Agent usage cost is agent-level, not project-attributed. With a project
  // filter active, the global cost map is withheld so a whole-fleet cost is
  // never assigned to one project; agent rows then report cost as not
  // tracked instead of a misleading number.
  const agentUsageCostByMember = useMemo(() => {
    if (!isAgentsEnabled || sourceFilter === 'company' || selectedProjectIds.size > 0) return undefined;
    return trackedAgentUsageCostByMember(computeAgentAnalytics({
      activities: agentActivity, timeEntries, team, projects, range, now,
      timezone: preferredTimezone,
    }));
  }, [isAgentsEnabled, agentActivity, timeEntries, team, projects, range, now, preferredTimezone, selectedProjectIds, sourceFilter]);

  // Cost and contribution for the active source's Overview strip. Earned and
  // hours come from the sourceData engine pass so strip and chart agree.
  const attribution = useMemo(() => {
    if (sourceFilter === 'company') return null;
    return computeFinanceAttribution({
      projects, invoices: projectInvoices, timeEntries, team, rateByProject,
      now, timezone: preferredTimezone, range, selectedProjectIds,
      lineSharePercent, accruingRetainerLines,
      agentUsageCostByMember,
      selectedMemberIds: sourceFilter === 'member' && sourceMemberId ? new Set([sourceMemberId]) : undefined,
      selectedSources: sourceFilter !== 'member' ? new Set([sourceFilter]) : undefined,
    });
  }, [projects, projectInvoices, timeEntries, team, rateByProject, now, preferredTimezone, range, selectedProjectIds, lineSharePercent, accruingRetainerLines, agentUsageCostByMember, sourceFilter, sourceMemberId]);

  // Label for the active source, shown as a pill in the Overview header and
  // as a suffix on the chart heading.
  const sourceLabel = sourceFilter === 'company'
    ? null
    : sourceFilter === 'member'
      ? (team.find(m => m.id === sourceMemberId)?.name ?? 'Contributor')
      : SOURCE_OPTIONS.find(o => o.value === sourceFilter)?.label ?? null;

  const costNotTrackedReason = selectedProjectIds.size > 0
    ? 'Agent usage cost is tracked per agent, not per project, so it cannot be assigned to a project-scoped view. Clear the project filter to see agent cost and contribution.'
    : 'No usage data yet for one or more agents in this selection.';

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

  // Exit drilldown when the user changes the range, the project filter, or
  // the earnings source - the drilled level might no longer be relevant under
  // the new scope. Derived-from-props pattern: compare against the last
  // filter snapshot and reset during render rather than in an effect (effect
  // form triggers React's set-state-in-effect lint).
  const filterKey = `${range.startKey}_${range.endKey}_${[...selectedProjectIds].sort().join(',')}_${sourceFilter}_${sourceMemberId ?? ''}`;
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
  // the `data` useMemo so we don't re-scan time entries or invoices - just
  // pluck out the days in the bucket window and shape them into DayBar[].
  const bucketDayBars = useMemo<DayBar[] | null>(() => {
    if (!drilldownBucket) return null;
    const { startKey, endKey } = drilldownBucket;
    const todayKey = nowDayKey;
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
      const dayWork = chartData.workByDay.get(dk);
      if (dayWork) {
        for (const [pid, w] of dayWork) {
          hours += w.hours;
          hourly += w.value;
          teamContribution += w.teamContribution;
          bumpProject(pid, { hours: w.hours, value: w.value, teamContribution: w.teamContribution });
        }
      }
      const dayFixed = chartData.fixedByDayProject.get(dk);
      if (dayFixed) {
        for (const [pid, dollars] of dayFixed) {
          fixed += dollars;
          bumpProject(pid, { fixed: dollars });
        }
      }
      const dayRecurring = chartData.recurringByDayProject.get(dk);
      if (dayRecurring) {
        for (const [pid, dollars] of dayRecurring) {
          recurring += dollars;
          bumpProject(pid, { recurring: dollars });
        }
      }
      const payments = chartData.paymentsByDay.get(dk) ?? 0;

      const projectWork: DayProjectWork[] = Array.from(projectMap.entries())
        .map(([pid, w]) => {
          const proj = chartData.projectLookup.get(pid);
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
        label: bucketAxisLabel(dk, 'day', todayKey, region.locale),
        tooltipDate: bucketTooltipLabel(dk, dk, 'day', region.locale),
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
  }, [drilldownBucket, chartData, nowDayKey, region.locale]);

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

    // Hourly work, split per local hour-of-day. Scans the effective arrays so
    // the drilldown matches the parent chart under both the project filter
    // and the earnings-source filter.
    const includeProject = (id: string) =>
      selectedProjectIds.size === 0 || selectedProjectIds.has(id);
    const payableMemberIds = new Set(
      team.filter(member => member.role !== 'owner' && member.role !== 'agent').map(member => member.id),
    );
    for (const te of effectiveTimeEntries) {
      if (!includeProject(te.project_id)) continue;
      const rate = te.hourly_rate ?? rateByProject.get(te.project_id) ?? 0;
      const perHour = getWorkedHoursByHour(projectTimeEntryForBilling(te, now), drilldownDay, now);
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

    // Fixed and recurring line items vest across the service day. Past hours
    // count fully, the current hour counts partially, and future hours are zero.
    // Same lines and the same company-share rule as the engine, so the day
    // view adds up to the bar it was opened from.
    for (const line of serviceAccrualLines(
      effectiveInvoices,
      { lineSharePercent, accruingRetainerLines: effectiveAccruingLines },
      includeProject,
    )) {
      const dollarsThatDay =
        (spreadLineItem(line.item, line.fallbackDate).get(drilldownDay) ?? 0) * (1 - line.shareRatio);
      // A discount line is negative and comes off the same buckets.
      if (dollarsThatDay === 0) continue;
      const perHourDollars = dollarsThatDay / 24;
      const isRecurring = line.item.item_type === 'recurring';
      for (let h = 0; h < 24; h++) {
        const vestedDollars = perHourDollars * hourVestingRatio(drilldownDay, h, now, preferredTimezone);
        if (vestedDollars === 0) continue;
        if (isRecurring) buckets[h].recurring += vestedDollars;
        else buckets[h].fixed += vestedDollars;
        bumpProject(buckets[h], line.projectId, isRecurring ? { recurring: vestedDollars } : { fixed: vestedDollars });
      }
    }

    // Payments received on this calendar day, spread evenly across the 24
    // hours. paid_date carries no time-of-day so per-hour attribution is a
    // visual convenience, not a claim about when the money arrived.
    let paymentsToday = 0;
    const inCurrency = invoiceInCurrency(region.currency);
    for (const inv of effectiveInvoices) {
      if (!includeProject(inv.project_id) || !inCurrency(inv)) continue;
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
        label: fmtHourLabel(h, region.locale),
        tooltipDate: `${fmtHourLabel(h, region.locale)} – ${fmtHourLabel((h + 1) % 24, region.locale)}`,
        hourlyValue: b.hourly,
        hoursWorked: b.hours,
        fixedRevenue: b.fixed,
        recurringRevenue: b.recurring,
        paymentReceived: b.payments,
        teamContribution: b.teamContribution,
        projectWork,
      };
    });
  }, [drilldownDay, effectiveTimeEntries, team, rateByProject, effectiveInvoices, projects, now, preferredTimezone, selectedProjectIds, lineSharePercent, effectiveAccruingLines, region]);

  // What the chart actually renders, in priority order:
  //   hour drilldown → bucket drilldown → main range.
  const chartBars = hourlyBars ?? bucketDayBars ?? chartData.dailyBars;
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
  const chartIsEmpty = !hasAnyChartData || (!showHourly && !showRecurring && !showFixed && !showTeam && !showPayments);

  // Track which categories have data so legend only shows relevant items
  const categoryHasData = useMemo(() => ({
    hourly: chartBars.some(d => d.hourlyValue > 0),
    recurring: chartBars.some(d => d.recurringRevenue > 0),
    fixed: chartBars.some(d => d.fixedRevenue > 0),
    payments: chartBars.some(d => d.paymentReceived > 0),
    team: chartBars.some(d => Math.abs(d.teamContribution) > 0.005),
  }), [chartBars]);

  return (
    <div className="space-y-4 lg:space-y-6">
        {/* ── Overview + Date Filter ──────────────────────── */}
        <div className="glass-card rounded-xl">
          <div className="px-4 py-3.5 lg:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <DollarSign size={16} aria-hidden="true" className="text-zinc-400" />
              <h2 className="text-sm font-semibold text-white">Totals</h2>
              {sourceLabel && (
                <Pill tone="info">
                  {sourceLabel}
                </Pill>
              )}
              <LiveTickIndicator
                timerCount={runningCount}
                fixedIncomeLive={liveServiceRevenue.fixed}
                recurringIncomeLive={liveServiceRevenue.recurring}
              />
            </div>

            {/* Three dropdowns no longer fit one mobile row; the source
                filter wraps to its own full-width line below sm. */}
            <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            <span className="hidden sm:inline text-xs text-zinc-500 font-medium">
              {fmtRangeDisplay(range.startKey, range.endKey)}
            </span>

            {/* Compact date range dropdown */}
            <div ref={rangeDropdownRef} className="relative flex-1 sm:flex-none">
              <button
                type="button"
                onClick={() => setRangeOpen(o => !o)}
                aria-expanded={rangeOpen}
                aria-haspopup="menu"
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] transition-colors"
              >
                <CalendarRange size={13} className="text-zinc-400 flex-shrink-0" />
                <span className="text-xs font-medium text-zinc-300 whitespace-nowrap">
                  {PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom'}
                </span>
                <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${rangeOpen ? 'rotate-180' : ''}`} />
              </button>

              <Popover
                anchorRef={rangeDropdownRef}
                open={rangeOpen}
                onClose={() => setRangeOpen(false)}
                align="end"
                ignoreOutsideSelector='[role="dialog"][aria-label="Date picker"]'
                className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
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
                              ? 'bg-brand-500/15 text-brand-300 font-medium'
                              : 'text-zinc-300 hover:bg-white/[0.03]'
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
                      <div className="border-t border-white/[0.06] bg-white/[0.03] p-3 space-y-2">
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
              </Popover>
            </div>

            {/* Project filter dropdown - same compact pattern as the date
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
                <div ref={projectFilterDropdownRef} className="relative flex-1 sm:flex-none">
                  <button
                    type="button"
                    onClick={() => setProjectFilterOpen(o => !o)}
                    aria-expanded={projectFilterOpen}
                    aria-haspopup="menu"
                    className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] transition-colors"
                  >
                    <FolderKanban size={13} className="text-zinc-400 flex-shrink-0" />
                    <span className="text-xs font-medium text-zinc-300 truncate max-w-[140px]">{buttonLabel}</span>
                    <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${projectFilterOpen ? 'rotate-180' : ''}`} />
                  </button>

                  <Popover
                    anchorRef={projectFilterDropdownRef}
                    open={projectFilterOpen}
                    onClose={() => setProjectFilterOpen(false)}
                    align="end"
                    className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
                  >
                      <div className="px-2.5 py-2 border-b border-white/[0.06] flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-zinc-400">
                          Projects
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedProjectIds(new Set())}
                          disabled={allSelectedOrNone}
                          className="text-[11px] font-medium text-zinc-400 hover:text-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto py-1">
                        {filterableProjects.length === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-zinc-500">No active projects</p>
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
                                className="w-full text-left text-sm px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors flex items-center gap-2"
                              >
                                <span
                                  className={`flex items-center justify-center w-4 h-4 rounded border transition-colors flex-shrink-0 ${
                                    checked
                                      ? 'bg-brand-600 border-brand-600 text-white'
                                      : 'border-white/[0.12] bg-surface-raised'
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
                                <span className="text-zinc-300 truncate flex-1 min-w-0">{p.name}</span>
                              </button>
                            );
                          })
                        )}
                      </div>
                  </Popover>
                </div>
              );
            })()}

            {/* Earnings-source filter - re-scopes the chart and the Overview
                strip. Same compact pattern as the date and project dropdowns. */}
            {(() => {
              const members = team
                .filter(m => m.role !== 'guest' && m.status !== 'suspended' && (isAgentsEnabled || m.role !== 'agent'))
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
              const sourceOptions = isAgentsEnabled ? SOURCE_OPTIONS : SOURCE_OPTIONS.filter(o => o.value !== 'agent');
              const buttonLabel = sourceFilter === 'member'
                ? (team.find(m => m.id === sourceMemberId)?.name ?? 'Contributor')
                : (SOURCE_OPTIONS.find(o => o.value === sourceFilter)?.label ?? 'Company');
              return (
                <div ref={sourceFilterDropdownRef} className="relative flex-1 sm:flex-none">
                  <button
                    type="button"
                    onClick={() => setSourceFilterOpen(o => !o)}
                    aria-expanded={sourceFilterOpen}
                    aria-haspopup="menu"
                    className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
                  >
                    <Users size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs font-medium text-zinc-300 truncate max-w-[140px]">{buttonLabel}</span>
                    <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${sourceFilterOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>

                  <Popover
                    anchorRef={sourceFilterDropdownRef}
                    open={sourceFilterOpen}
                    onClose={() => setSourceFilterOpen(false)}
                    align="end"
                    className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
                  >
                    <div className="px-2.5 py-2 border-b border-white/[0.06]">
                      <span className="text-[11px] font-semibold text-zinc-400">Earnings source</span>
                    </div>
                    <div className="p-1">
                      {sourceOptions.map(opt => {
                        const active = sourceFilter === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              setSourceFilter(opt.value);
                              setSourceMemberId(null);
                              setSourceFilterOpen(false);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-md transition-colors ${
                              active ? 'bg-brand-500/15' : 'hover:bg-white/[0.03]'
                            }`}
                          >
                            <span className={`block text-sm ${active ? 'text-brand-300 font-medium' : 'text-zinc-300'}`}>{opt.label}</span>
                            <span className="block text-[11px] text-zinc-500">{opt.hint}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="border-t border-white/[0.06]">
                      <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold text-zinc-400">Individual contributor</p>
                      <div className="max-h-[240px] overflow-y-auto pb-1 px-1">
                        {members.map(m => {
                          const active = sourceFilter === 'member' && sourceMemberId === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => {
                                setSourceFilter('member');
                                setSourceMemberId(m.id);
                                setSourceFilterOpen(false);
                              }}
                              className={`w-full text-left text-sm px-1.5 py-1.5 rounded-md transition-colors flex items-center gap-2 ${
                                active ? 'bg-brand-500/15 text-brand-300 font-medium' : 'text-zinc-300 hover:bg-white/[0.03]'
                              }`}
                            >
                              <Avatar name={m.name} src={m.avatar || undefined} size="xs" />
                              <span className="truncate flex-1 min-w-0">{m.name}</span>
                              {m.role === 'agent' && (
                                <Pill tone="info">AI</Pill>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </Popover>
                </div>
              );
            })()}
            </div>
          </div>

          {sourceData && attribution ? (
            /* Source view: the contributor lens. Invoice metrics are
               company money, so they only render in the company view. */
            <StatStrip
              bare
              className="px-4 py-4 lg:px-5"
              label="Contributor totals"
              stats={[
                { label: 'Earned', value: money(sourceData.totalEarned) },
                {
                  label: 'Recorded cost',
                  value: attribution.recordedCost !== null ? money(attribution.recordedCost) : null,
                  empty: <NotTrackedValue reason={costNotTrackedReason} />,
                                  },
                {
                  label: 'Contribution',
                  value: attribution.contribution !== null ? money(attribution.contribution) : null,
                  empty: <NotTrackedValue reason={costNotTrackedReason} />,
                                  },
                { label: 'Hours', value: formatHours(sourceData.totalHours) },
              ]}
            />
          ) : (
            <StatStrip
              bare
              className="px-4 py-4 lg:px-5"
              label="Totals"
              stats={[
                { label: 'Earned', value: money(data.totalEarned) },
                // Worked but unapproved value. Shown rather than folded into
                // Earned so reviewing a session can only ever move this number
                // into Earned, never make Earned fall.
                data.totalPendingEarned > 0.005 && {
                  id: 'pending',
                  label: (
                    <Tooltip content="Worked time awaiting your approval. It becomes Earned once approved.">
                      <span className="cursor-help">Pending</span>
                    </Tooltip>
                  ),
                  value: money(data.totalPendingEarned),
                  context: 'Awaiting approval',
                },
                {
                  label: 'Outstanding',
                  value: money(data.totalOutstanding),
                                    context: data.totalOverdue > 0 ? <span className="text-red-300">{money(data.totalOverdue)} overdue</span> : undefined,
                },
                { label: 'Invoiced', value: money(data.totalInvoiced) },
                { label: 'Received', value: money(data.totalPaymentsReceived) },
                { label: 'Total hours', value: formatHours(data.totalHours) },
                // Every currency counts here; the money totals add the workspace
                // currency only, so this is where the strip says what they leave out.
                { label: 'Invoices', value: data.activeInvoicesCount, context: excludedNote(data.excludedInvoices, 'invoice', true) || undefined },
              ]}
            />
          )}
        </div>

        {/* ── Main Grid ───────────────────────────────────── */}
        <div className="card-row lg:grid-cols-3">

          {/* ── Daily earnings chart (2/3) ──────────────────── */}
          {/* An empty chart stays short on phones instead of a tall blank card. */}
          <div className={`lg:col-span-2 glass-card rounded-xl overflow-hidden flex flex-col ${chartIsEmpty ? 'min-h-[200px] lg:min-h-[300px]' : 'min-h-[500px]'}`}>
            <div className="px-4 py-3.5 lg:px-5 flex items-center justify-between gap-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <TrendingUp size={16} aria-hidden="true" className="text-zinc-400 flex-shrink-0" />
                <h2 className="text-sm font-semibold text-white truncate">
                  {isHourView
                    ? `Hourly earnings · ${fmtDate(drilldownDay!, true)}`
                    : isBucketView
                      ? `Daily earnings · ${fmtRangeDisplay(drilldownBucket!.startKey, drilldownBucket!.endKey)}`
                      : `${chartData.granularity === 'month' ? 'Monthly' : chartData.granularity === 'week' ? 'Weekly' : 'Daily'} earnings${sourceLabel ? ` · ${sourceLabel}` : ''}`}
                </h2>
                <LiveTickIndicator
                  timerCount={runningCount}
                  fixedIncomeLive={liveServiceRevenue.fixed}
                  recurringIncomeLive={liveServiceRevenue.recurring}
                />
                {isDrilledDown && (
                  <button
                    type="button"
                    onClick={() => {
                      // Pop one level: hour → bucket (or main), bucket → main.
                      if (isHourView) setDrilldownDay(null);
                      else setDrilldownBucket(null);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.03] flex-shrink-0"
                    aria-label="Back one level"
                  >
                    <ChevronDown size={14} className="rotate-90" />
                    Back
                  </button>
                )}
              </div>
              <span className="text-xs text-zinc-500 font-medium hidden sm:inline">
                {isHourView
                  ? 'Click bar to pin hour'
                  : isBucketView
                    ? 'Click a day to drill in'
                    : (PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range')}
              </span>
            </div>

            <div className="chart-vivid px-5 pt-5 pb-4 flex-1 flex flex-col">
              {(!showHourly && !showRecurring && !showFixed && !showTeam && !showPayments) ? (
                /* Empty state when both series are toggled off */
                <EmptyState compact icon={<TrendingUp />} title="No data series selected" description="Toggle a legend below to view earnings data." className="flex-1" />
              ) : !hasAnyChartData ? (
                /* Empty state when there's no data in the selected range */
                <EmptyState compact icon={<TrendingUp />} title="No earnings in this range" description="Try a different date range or log some billable time." className="flex-1" />
              ) : (
                <>
                  {/* Chart area with Y-axis */}
                  <div className="flex gap-0 flex-1 min-h-[160px]">
                    {/* Y-axis labels */}
                    <div className="flex flex-col justify-between flex-shrink-0 pr-2">
                      {[...axisTicks].reverse().map((tick) => (
                        <span
                          key={tick}
                          className="text-[11px] text-zinc-500 font-medium leading-none text-right"
                          style={{ minWidth: 36 }}
                        >
                          {money.compact(tick)}
                        </span>
                      ))}
                    </div>

                    {/* Bars + grid */}
                    <div className="flex-1 relative min-w-0">
                      {/* Horizontal grid lines */}
                      {axisTicks.map((tick) => {
                        const pct = axisRange > 0 ? ((axisMax - tick) / axisRange) * 100 : 0;
                        return (
                          <div
                            key={`grid-${tick}`}
                            className={`absolute left-0 right-0 border-t ${tick === 0 && axisMin < 0 ? 'border-white/[0.12]' : 'border-white/[0.06]'}`}
                            style={{ top: `${pct}%` }}
                          />
                        );
                      })}

                      {/* Bars — fixed ~30-bar window on mobile; longer ranges
                          scroll horizontally and the labels mirror the scroll.
                          The viewport is absolute inset-0 so its height is
                          robustly the plot height (no % height chain). */}
                      <div
                        ref={chartBarsScrollRef}
                        onScroll={(e) => {
                          if (chartLabelsScrollRef.current) chartLabelsScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
                        }}
                        onClick={() => setSelectedBar(null)}
                        className="absolute inset-0 overflow-x-auto sm:overflow-visible no-scrollbar"
                      >
                      <div
                        className="chart-scroll-content flex items-end gap-[3px] relative z-[1] h-full"
                        style={{ '--bar-count': chartBars.length } as React.CSSProperties}
                      >
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
                          const canDrillToBucket = !isDrilledDown && chartData.granularity !== 'day';
                          const canDrillToHour = !isHourView && (isBucketView || chartData.granularity === 'day');

                          // Figure out which segment is at the top so it gets rounded corners.
                          // Order top→bottom: payment, hourly, fixed, recurring.
                          const topIsPayment = visiblePayment > 0;
                          const topIsTeam = !topIsPayment && positiveTeam > 0;
                          const topIsHourly = !topIsPayment && !topIsTeam && visibleHourly > 0;
                          const topIsFixed = !topIsPayment && !topIsTeam && !topIsHourly && visibleFixed > 0;

                          // Height of the actual coloured bar (sum of visible segments), as a
                          // % of the column — used to size the glass sheen overlay so it covers
                          // only the bar, never the empty plotting area above it.
                          const barHeightPct = ((visiblePayment > 0 ? Math.max(paymentPct, 1.5) : 0)
                            + (positiveTeam > 0 ? Math.max(teamPositivePct, 1.5) : 0)
                            + (visibleHourly > 0 ? Math.max(hourlyPct, 1.5) : 0)
                            + (visibleFixed > 0 ? Math.max(fixedPct, 1.5) : 0)
                            + (visibleRecurring > 0 ? Math.max(recurringPct, 1.5) : 0)) / 100 * positiveAreaPct;

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
                                  {/* Glass sheen sized to the coloured bar only (never the empty area above). */}
                                  <div
                                    className="chart-bar pointer-events-none absolute inset-x-0 rounded-t overflow-hidden"
                                    style={{ bottom: `${zeroBottomPct}%`, height: `${barHeightPct}%` }}
                                    aria-hidden="true"
                                  />
                                  {negativeTeam < 0 && (
                                    <div className="absolute inset-x-0" style={{ top: `${positiveAreaPct}%`, height: `${negativeAreaPct}%` }}>
                                      <div className="w-full rounded-b bg-rose-400 transition-colors duration-150 group-hover:bg-rose-500" style={{ height: `${Math.max(teamNegativePct, 2)}%` }} />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="absolute inset-x-0 bg-white/[0.06]" style={{ bottom: `${zeroBottomPct}%`, height: 2 }} />
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
                                      a flex-shrink-0 grand-total footer - so the user's
                                      anchors (which day, what's the day's total) stay visible
                                      no matter how many projects are on the bar. */}
                                  <div
                                    className="bg-surface-overlay border border-white/[0.08] text-white text-[11px] leading-relaxed px-2.5 py-1.5 rounded-md whitespace-nowrap shadow-lg max-w-[300px] max-h-[60vh] flex flex-col pointer-events-auto"
                                    /* Stop clicks on the tooltip body from bubbling up to the
                                       bar's onClick - otherwise tapping inside the tooltip
                                       (e.g. trying to scroll on mobile) would drill the bar
                                       or toggle its sticky state and hide the tooltip. */
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <p className="font-semibold text-zinc-200 mb-1 flex-shrink-0 truncate">{day.tooltipDate}</p>
                                    {day.projectWork.length > 0 && (() => {
                                      // Group by earning category (Hourly / Fixed / Recurring)
                                      // so each $ amount on a row maps to exactly one category -
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
                                          <span className="text-zinc-500 flex-1 min-w-0 truncate" title={row.projectName}>{row.projectName}</span>
                                          {row.hours !== undefined && row.hours > 0 && (
                                            <span className="text-zinc-300 flex-shrink-0">{formatHours(row.hours)}</span>
                                          )}
                                          <span className={`font-semibold flex-shrink-0 ${row.amount < 0 ? 'text-rose-300' : ''}`}>{money(row.amount)}</span>
                                        </div>
                                      );

                                      return (
                                        <div className="flex flex-col min-h-0 flex-1">
                                          {/* Scrollable middle - only this region scrolls when
                                              the project list overflows the tooltip's max-h. */}
                                          <div className="overflow-y-auto flex-1 min-h-0">
                                            {sections.map((section, idx) => (
                                              <div key={section.key} className={idx > 0 ? 'mt-1.5' : ''}>
                                                {isMultiCategory && (
                                                  <div className="flex items-baseline gap-1">
                                                    <span className="text-[11px] text-zinc-500 font-semibold">{section.label}</span>
                                                    {section.rows.length > 1 && (
                                                      <span className="text-[9px] text-zinc-600">({money(section.totalAmount)})</span>
                                                    )}
                                                  </div>
                                                )}
                                                <div className={`space-y-0.5 ${isMultiCategory ? 'mt-0.5' : ''}`}>
                                                  {section.rows.map(row => renderProjectRow(section.key, row, isMultiCategory))}
                                                </div>
                                              </div>
                                            ))}
                                          </div>

                                          {/* Pinned footer - flex-shrink-0 keeps it visible
                                              even when the body above is scrolling. */}
                                          {showGrandTotal && (
                                            <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center justify-between gap-3 text-zinc-100 flex-shrink-0">
                                              <span className="text-[11px] text-zinc-500">Total earned</span>
                                              <span className="font-semibold">{money(totalEarnedDay)}</span>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                    {visPaymentVal > 0 && (
                                      <p className="text-emerald-300 mt-0.5 flex-shrink-0">Payments: <span className="font-semibold">{money(visPaymentVal)}</span></p>
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
                  </div>

                  {/* Day labels - aligned to bars; mirror the bars' horizontal scroll on mobile. */}
                  <div className="mt-2" style={{ marginLeft: 44 }}>
                    <div ref={chartLabelsScrollRef} className="overflow-x-hidden sm:overflow-visible no-scrollbar">
                      <div
                        className="chart-scroll-content flex gap-[3px]"
                        style={{ '--bar-count': chartBars.length } as React.CSSProperties}
                      >
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
                          <span className="text-[11px] text-zinc-500 font-medium truncate block">
                            {showLabel ? day.label : ''}
                          </span>
                        </div>
                      );
                    })}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Legend (toggleable) - only show categories that have data */}
              {(categoryHasData.hourly || categoryHasData.recurring || categoryHasData.fixed || categoryHasData.team || categoryHasData.payments) && (
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-white/[0.06] flex-wrap">
                  {categoryHasData.hourly && (
                    <button
                      type="button"
                      onClick={() => setShowHourly(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showHourly ? 'bg-sky-500/15' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showHourly ? 'bg-sky-400' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-300 font-medium">Hourly</span>
                    </button>
                  )}
                  {categoryHasData.recurring && (
                    <button
                      type="button"
                      onClick={() => setShowRecurring(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showRecurring ? 'bg-amber-500/15' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showRecurring ? 'bg-amber-400' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-300 font-medium">Recurring</span>
                    </button>
                  )}
                  {categoryHasData.fixed && (
                    <button
                      type="button"
                      onClick={() => setShowFixed(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showFixed ? 'bg-violet-500/15' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showFixed ? 'bg-violet-500' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-300 font-medium">Fixed</span>
                    </button>
                  )}
                  {categoryHasData.team && (
                    <button
                      type="button"
                      onClick={() => setShowTeam(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showTeam ? 'bg-teal-500/15' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`flex w-2.5 h-2.5 overflow-hidden rounded-sm ${showTeam ? '' : 'bg-zinc-300'}`}>
                        {showTeam && <><span className="w-1/2 bg-teal-500" /><span className="w-1/2 bg-rose-400" /></>}
                      </div>
                      <span className="text-[11px] text-zinc-300 font-medium">Team contribution</span>
                    </button>
                  )}
                  {categoryHasData.payments && (
                    <button
                      type="button"
                      onClick={() => setShowPayments(prev => !prev)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${showPayments ? 'bg-emerald-500/15' : 'opacity-40 hover:opacity-70'}`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-sm ${showPayments ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                      <span className="text-[11px] text-zinc-300 font-medium">Payments</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Invoices (1/3) ──────────────────────── */}
          <div className="glass-card card-fill rounded-xl overflow-hidden">
            <div className="px-4 py-3.5 lg:px-5 flex items-center justify-between gap-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <Receipt size={16} aria-hidden="true" className="text-zinc-400" />
                <h2 className="text-sm font-semibold text-white">
                  Invoices
                  {data.allInvoices.length > 0 && (
                    <span className="ml-1.5 text-xs font-medium text-zinc-500">({data.allInvoices.length})</span>
                  )}
                </h2>
              </div>
              <span className="text-xs text-zinc-500 font-medium">{PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range'}</span>
            </div>

            {data.allInvoices.length > 0 ? (
              <div className="card-scroll divide-y divide-white/[0.06]">
                {data.allInvoices.map((inv) => {
                  const project = projects.find(p => p.id === inv.project_id);
                  const items = ensureLineItems(inv);
                  const isMulti = items.length > 1;
                  const singleItemType = items[0]?.item_type;
                  return (
                    <Link
                      key={inv.id}
                      href={`/projects/${inv.project_id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{inv.invoice_number}</span>
                          <Pill tone={STATUS_TONE[inv.status] ?? 'neutral'} dot>{sentenceCase(inv.status)}</Pill>
                          <Pill>{isMulti ? `${items.length} items` : sentenceCase(singleItemType ?? inv.invoice_type)}</Pill>
                        </div>
                        <p className="text-xs text-zinc-400 mt-0.5 truncate">{project?.name || 'Unknown project'}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-white">{money.exact(inv.amount, inv.currency)}</p>
                        <p className="text-[11px] text-zinc-500">{fmtDate(inv.date)}</p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <EmptyState compact icon={<Receipt />} title="No invoices in this range" description="Try a different date range or create an invoice." className="flex-1" />
            )}
          </div>
        </div>

        {/* ── Project Breakdown ────────────────────────────── */}
        <div className="glass-card rounded-xl overflow-hidden flex flex-col min-h-[260px]">
            <div className="px-4 py-3.5 lg:px-5 flex items-center justify-between gap-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <FolderKanban size={16} aria-hidden="true" className="text-zinc-400" />
                <h2 className="text-sm font-semibold text-white">By project</h2>
                <LiveTickIndicator
                  timerCount={runningCount}
                  fixedIncomeLive={liveServiceRevenue.fixed}
                  recurringIncomeLive={liveServiceRevenue.recurring}
                />
              </div>
              <span className="text-xs text-zinc-500 font-medium">{PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range'}</span>
            </div>

            {data.projectBreakdown.length > 0 ? (
              <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-2.5 text-[11px] font-medium text-zinc-500 border-b border-white/[0.06]">
                <span>Project</span>
                <span className="text-right w-24">Earned</span>
                <span className="text-right w-24">Received</span>
                <span className="text-right w-24">Invoiced</span>
                <span className="text-right w-24">Outstanding</span>
                <span className="text-right w-20">Hours</span>
              </div>

              <div className="divide-y divide-white/[0.06]">
                {data.projectBreakdown.map((p) => {
                  const receivedPct = p.earned > 0 ? (p.received / p.earned) * 100 : 0;
                  return (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-3.5 items-center hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {p.color && (
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                        )}
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-white truncate block">{p.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <div className="w-16 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full bg-emerald-400"
                                style={{ width: `${Math.min(receivedPct, 100)}%` }}
                              />
                            </div>
                            {p.isHourly && p.hourlyRate && (
                              <span className="text-[11px] text-zinc-500">{money(p.hourlyRate)}/hr</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="text-sm font-semibold text-white text-right w-24 tabular-nums">{money(p.earned)}</span>
                      <span className="text-sm text-zinc-300 font-medium text-right w-24 tabular-nums">{money(p.received)}</span>
                      <span className="text-sm text-zinc-300 font-medium text-right w-24 tabular-nums">{money(p.invoiced)}</span>
                      <span className={`text-sm font-medium text-right w-24 tabular-nums ${p.outstanding > 0 ? 'text-zinc-300' : 'text-zinc-600'}`}>
                        {p.outstanding > 0 ? money(p.outstanding) : '-'}
                      </span>
                      <span className={`text-sm text-right w-20 tabular-nums ${p.hours > 0 ? 'text-zinc-300 font-medium' : 'text-zinc-600'}`}>
                        {p.hours > 0 ? formatHours(p.hours) : '-'}
                      </span>
                    </Link>
                  );
                })}
              </div>

              {/* Totals */}
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-6 px-5 py-3.5 border-t border-white/[0.08] bg-white/[0.03]">
                <span className="text-sm font-semibold text-zinc-300">Total</span>
                <span className="text-sm font-semibold text-white text-right w-24 tabular-nums">{money(data.totalEarned)}</span>
                <span className="text-sm font-semibold text-white text-right w-24 tabular-nums">{money(data.totalPaymentsReceived)}</span>
                <span className="text-sm font-semibold text-white text-right w-24 tabular-nums">{money(data.totalInvoiced)}</span>
                <span className={`text-sm font-semibold text-right w-24 tabular-nums ${data.totalOutstanding > 0 ? 'text-white' : 'text-zinc-600'}`}>
                  {data.totalOutstanding > 0 ? money(data.totalOutstanding) : '-'}
                </span>
                <span className="text-sm font-semibold text-white text-right w-20 tabular-nums">{formatHours(data.totalHours)}</span>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-white/[0.06]">
              {data.projectBreakdown.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="block p-4 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    {p.color && <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
                    <span className="text-sm font-medium text-white truncate">{p.name}</span>
                  </div>
                  <StatStrip
                    bare
                    label={`${p.name} totals`}
                    stats={[
                      { label: 'Earned', value: money(p.earned) },
                      { label: 'Received', value: money(p.received) },
                      { label: 'Outstanding', value: p.outstanding > 0 ? money(p.outstanding) : null, empty: '-' },
                      { label: 'Hours', value: p.hours > 0 ? formatHours(p.hours) : null, empty: '-' },
                    ]}
                  />
                </Link>
              ))}
            </div>
              </>
            ) : (
              <EmptyState compact icon={<FolderKanban />} title="No project activity in this range" description="Projects with invoices or logged hours will appear here." className="flex-1" />
            )}
          </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: one header, the tabs this person may see
// ---------------------------------------------------------------------------

/**
 * Finances, for whoever has a money view: the company Overview (Client
 * invoicing), Time (the shared timesheet), Team pay (for whoever runs pay) or My earnings (Team pay, for everyone else who is paid). The
 * name and the tabs come from `financeViews`, which the sidebar reads too,
 * so the two always agree. Someone with no money view has the timesheet
 * alone, at /time, and is sent there.
 */
export default function FinancesPage() {
  // useSearchParams (the open tab) needs a Suspense boundary on a static page.
  return (
    <Suspense fallback={null}>
      <FinancesTabs />
    </Suspense>
  );
}

function FinancesTabs() {
  const { projects, team, employeeEarnings } = useApp();
  const { access } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const views = financeViews(access);
  const goesToTime = views.entry?.href === '/time';

  useEffect(() => {
    if (goesToTime) router.replace('/time');
  }, [goesToTime, router]);

  if (!views.entry || goesToTime) return null;

  const requested = searchParams.get('tab') as FinanceTab | null;
  const active: FinanceTab | null = requested && views.tabs.includes(requested) ? requested : views.tabs[0] ?? null;
  // The open tab is the URL's ?tab=, so it can be linked to and survives a
  // reload; the default tab keeps the bare URL.
  const setActive = (tab: FinanceTab) => {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === views.tabs[0]) next.delete('tab');
    else next.set('tab', tab);
    const query = next.toString();
    window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
  };

  const canReadAllTime = hasPermission(access, 'time.read_all');
  const subtitles: Record<FinanceTab, string> = {
    overview: 'Revenue and invoices across every project.',
    time: canReadAllTime ? "Your hours and your team's, week by week." : 'Your hours, week by week.',
    payroll: 'Rates, approved hours and payouts for your team.',
    earnings: 'Your approved hours, rates and payouts.',
  };
  const hasPayableTeam = team.some(member => member.role !== 'owner' && member.role !== 'agent');

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={views.entry.label}
        subtitle={active ? <span className="hidden sm:inline">{subtitles[active]}</span> : undefined}
        // Upcoming invoices belongs with the company money: Overview only.
        actions={views.invoices && active === 'overview' ? (
          <Link
            href="/finances/billing"
            className="inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm font-medium text-zinc-300 border border-white/[0.08] bg-surface-raised hover:bg-white/[0.03] hover:text-white rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          >
            <CalendarClock size={14} aria-hidden="true" />
            Upcoming invoices
          </Link>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {views.tabs.length > 1 && active && (
          <ProjectTabs
            label={views.entry.label}
            tabs={views.tabs.map(tab => ({ key: tab, label: FINANCE_TAB_LABELS[tab] }))}
            active={active}
            onChange={setActive}
          />
        )}

        {active ? (
          <div
            id={projectPanelId(active)}
            role={views.tabs.length > 1 ? 'tabpanel' : undefined}
            aria-labelledby={views.tabs.length > 1 ? projectTabId(active) : undefined}
          >
            {active === 'overview' && <CompanyOverview />}
            {active === 'time' && <TimesheetView />}
            {active === 'payroll' && (hasPayableTeam
              ? <PayrollPanel team={team} projects={projects} />
              : (
                <FinanceEmpty
                  title="No one to pay yet"
                  body="Owners are not paid through Team pay. Invite a teammate, then set their pay rate here."
                  action={<Button href="/team" variant="secondary" size="sm">Open Team</Button>}
                />
              ))}
            {active === 'earnings' && (
              <EmployeeEarningsDashboard projects={projects} data={employeeEarnings ?? EMPTY_EMPLOYEE_EARNINGS} />
            )}
          </div>
        ) : (
          // Reads invoices, nothing else here: the one place to go is Upcoming invoices.
          <FinanceEmpty
            title="Invoices live in Upcoming invoices"
            body="You can see what bills next, by month and project."
            action={<Button href="/finances/billing" variant="secondary" size="sm">Open Upcoming invoices</Button>}
          />
        )}
      </div>
    </div>
  );
}

function FinanceEmpty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="glass-card rounded-xl px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-400">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
