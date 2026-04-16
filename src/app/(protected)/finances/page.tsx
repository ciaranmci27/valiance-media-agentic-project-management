'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { ensureLineItems, spreadLineItem } from '@/lib/invoice-utils';
import Link from 'next/link';
import {
  DollarSign,
  TrendingUp,
  Receipt,
  FolderKanban,
  CalendarRange,
  ChevronDown,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (rounded >= 1000) return `$${(rounded / 1000).toFixed(rounded % 1000 === 0 ? 0 : 1)}K`;
  return `$${rounded}`;
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
): { startKey: string; endKey: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endKey = toDateKey(today);

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
// Page
// ---------------------------------------------------------------------------

export default function FinancesPage() {
  const { projects, projectInvoices, timeEntries } = useApp();

  // ── Date range state ────────────────────────────────────────
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeDropdownRef = useRef<HTMLDivElement>(null);

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

  // Build a lookup: project_id -> hourly_rate (0 if not hourly)
  const rateByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of projects) {
      map.set(p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0);
    }
    return map;
  }, [projects]);

  // Find earliest data point across invoices and time entries for "All time"
  const earliestDateKey = useMemo(() => {
    let earliest: string | null = null;
    for (const inv of projectInvoices) {
      if (inv.date && (!earliest || inv.date < earliest)) earliest = inv.date;
    }
    for (const te of timeEntries) {
      if (!te.end_time) continue;
      const k = toDateKey(new Date(te.end_time));
      if (!earliest || k < earliest) earliest = k;
    }
    return earliest;
  }, [projectInvoices, timeEntries]);

  const range = useMemo(
    () => resolveRange(preset, customStart, customEnd, earliestDateKey),
    [preset, customStart, customEnd, earliestDateKey],
  );

  const data = useMemo(() => {
    const { startKey, endKey } = range;

    // ── Range-aware filters ────────────────────────────────
    // Invoices: filter by invoice `date` within the range
    const invoicesInRange = projectInvoices.filter(inv => inv.date >= startKey && inv.date <= endKey);
    // Time entries: filter by end_time within the range
    const entriesInRange = timeEntries.filter(te => {
      if (!te.end_time) return false;
      const k = toDateKey(new Date(te.end_time));
      return k >= startKey && k <= endKey;
    });
    // ── Totals (range-scoped) ──────────────────────────────
    // Invoices issued within the range (non-cancelled)
    const activeInvoices = invoicesInRange.filter(inv => inv.status !== 'cancelled');
    // Cash actually received during the range (by paid_date), regardless of when the invoice was issued
    const paymentsInRange = projectInvoices.filter(
      inv => inv.status === 'paid' && inv.paid_date && inv.paid_date >= startKey && inv.paid_date <= endKey,
    );
    // Overdue is a current-state snapshot, not a period stat — count all overdue invoices
    const totalOverdue = projectInvoices
      .filter(inv => inv.status === 'overdue')
      .reduce((s, i) => s + i.amount, 0);

    const totalInvoiced = activeInvoices.reduce((s, i) => s + i.amount, 0);
    const totalPaymentsReceived = paymentsInRange.reduce((s, i) => s + i.amount, 0);
    const activeInvoicesCount = activeInvoices.length;

    const completedEntries = entriesInRange;
    const totalHours = completedEntries.reduce((s, te) => s + getWorkedHours(te), 0);

    // Accrual earnings: hourly work value (rate × hours worked in range).
    // Non-hourly revenue is added below after amortization across service periods.
    const hourlyEarnedInRange = completedEntries.reduce(
      (s, te) => s + getWorkedHours(te) * (rateByProject.get(te.project_id) ?? 0),
      0,
    );

    // Collection rate: lifetime "money in hand" vs "money owed" snapshot.
    // = all-time received / (all-time received + currently outstanding)
    // Date-selector independent (matches Outstanding's all-time framing).
    const totalReceivedAllTime = projectInvoices
      .filter(inv => inv.status === 'paid')
      .reduce((s, i) => s + i.amount, 0);

    // ── Daily chart ─────────────────────────────────────────
    const todayKey = toDateKey(new Date());

    // Pre-index: payments received per day (uses paid_date, range-scoped)
    // Note: this uses paid_date independently of the invoice date filter,
    // so the chart reflects actual cash flow on each day.
    const paymentsByDay = new Map<string, number>();
    for (const inv of projectInvoices) {
      if (inv.status !== 'paid' || !inv.paid_date) continue;
      if (inv.paid_date < startKey || inv.paid_date > endKey) continue;
      paymentsByDay.set(inv.paid_date, (paymentsByDay.get(inv.paid_date) ?? 0) + inv.amount);
    }

    // Pre-index: amortized fixed and recurring line-item revenue per day, broken
    // down by project. Each non-hourly line item is spread across its service
    // period (or falls on the invoice date when no service window is set).
    // Hourly line items are ignored here (billable hours represent that revenue).
    const fixedByDayProject = new Map<string, Map<string, number>>();
    const recurringByDayProject = new Map<string, Map<string, number>>();
    for (const inv of projectInvoices) {
      if (inv.status === 'cancelled') continue;
      for (const li of ensureLineItems(inv)) {
        if (li.item_type === 'hourly') continue;
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

    // Pre-index: billable hours per day, broken down by project
    // We attribute a time entry to the day its end_time falls on.
    const workByDay = new Map<string, Map<string, { hours: number; value: number }>>();
    for (const te of completedEntries) {
      if (!te.end_time) continue;
      const endDate = new Date(te.end_time);
      const dayKey = toDateKey(endDate);
      const hours = getWorkedHours(te);
      const rate = rateByProject.get(te.project_id) ?? 0;
      if (!workByDay.has(dayKey)) workByDay.set(dayKey, new Map());
      const dayMap = workByDay.get(dayKey)!;
      const existing = dayMap.get(te.project_id) ?? { hours: 0, value: 0 };
      existing.hours += hours;
      existing.value += hours * rate;
      dayMap.set(te.project_id, existing);
    }

    // Lookup for project names/colors
    const projectLookup = new Map(projects.map(p => [p.id, p]));

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
      projects: Map<string, { hours: number; value: number; fixed: number; recurring: number }>;
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
          hours: 0, hourly: 0, fixed: 0, recurring: 0, payments: 0,
          projects: new Map(),
        };
        buckets.set(bStart, b);
      }
      return b;
    };
    const mergeProject = (b: BucketAgg, pid: string, delta: { hours?: number; value?: number; fixed?: number; recurring?: number }) => {
      const cur = b.projects.get(pid) ?? { hours: 0, value: 0, fixed: 0, recurring: 0 };
      cur.hours += delta.hours ?? 0;
      cur.value += delta.value ?? 0;
      cur.fixed += delta.fixed ?? 0;
      cur.recurring += delta.recurring ?? 0;
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
          mergeProject(b, pid, { hours: w.hours, value: w.value });
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
          projectWork,
        };
      });

    // Max bar height = max(hourly + fixed + recurring + payment) across the range
    const maxBarTotal = Math.max(
      ...dailyBars.map(d => d.hourlyValue + d.fixedRevenue + d.recurringRevenue + d.paymentReceived),
      1,
    );

    // Range-scoped totals derived from the daily bars (so Earned matches the chart)
    const totalAccruedInRange = dailyBars.reduce((s, d) => s + d.fixedRevenue + d.recurringRevenue, 0);
    const totalEarned = hourlyEarnedInRange + totalAccruedInRange;

    // ── Per-project outstanding (all-time, current snapshot) ─
    // Outstanding is a current-state stat (what's still owed right now), so it's
    // computed from all-time invoices and time entries — NOT date-filtered.
    // Same formula as the project details InvoicesPanel:
    //   hourly:     max(0, max(rate * hours, hourlyInvoiced) + fixedInvoiced - paid)
    //   non-hourly: max(0, invoiced - paid)
    const outstandingByProject = new Map<string, number>();
    for (const p of projects) {
      if (p.status === 'archived') continue;
      const pInvoicesAll = projectInvoices.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
      const pPaidAll = projectInvoices
        .filter(inv => inv.project_id === p.id && inv.status === 'paid')
        .reduce((s, i) => s + i.amount, 0);
      const pHoursAll = timeEntries
        .filter(te => te.project_id === p.id && te.end_time)
        .reduce((s, te) => s + getWorkedHours(te), 0);
      const isHourly = !!p.hourly_tracking;
      const rate = p.hourly_rate ?? 0;
      // Aggregate line-item amounts by type across all active invoices.
      let pHourlyInvoiced = 0;
      let pFixedInvoiced = 0;
      for (const inv of pInvoicesAll) {
        for (const li of ensureLineItems(inv)) {
          if (li.item_type === 'hourly') pHourlyInvoiced += Number(li.amount) || 0;
          else pFixedInvoiced += Number(li.amount) || 0;
        }
      }
      const pInvoicedTotal = pInvoicesAll.reduce((s, i) => s + i.amount, 0);
      const pBillable = isHourly
        ? Math.max(rate * pHoursAll, pHourlyInvoiced) + pFixedInvoiced
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

    const projectBreakdown = projects
      .filter(p => p.status !== 'archived')
      .map(p => {
        const pInvoices = invoicesInRange.filter(inv => inv.project_id === p.id && inv.status !== 'cancelled');
        const pPayments = paymentsInRange.filter(inv => inv.project_id === p.id);
        const pEntries = entriesInRange.filter(te => te.project_id === p.id);
        const pHours = pEntries.reduce((s, te) => s + getWorkedHours(te), 0);
        const rate = p.hourly_rate ?? 0;
        // Earned (accrual): hourly work value + amortized non-hourly line-item revenue
        const pHourlyEarned = pEntries.reduce((s, te) => s + getWorkedHours(te) * rate, 0);
        const pAccrued = accruedByProjectInRange.get(p.id) ?? 0;
        const pEarned = pHourlyEarned + pAccrued;

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
      .filter(p => p.invoiced > 0 || p.hours > 0 || p.outstanding > 0 || p.earned > 0)
      .sort((a, b) => b.earned - a.earned);

    // ── Invoices in range (sorted newest first) ─────────────
    const allInvoices = [...invoicesInRange]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      totalInvoiced, totalEarned, totalPaymentsReceived, totalOutstanding, totalOverdue,
      totalHours, collectionRate, activeInvoicesCount,
      dailyBars, maxBarTotal, granularity,
      projectBreakdown, allInvoices,
    };
  }, [projects, projectInvoices, timeEntries, rateByProject, range]);

  // ── Chart state & constants ────────────────────────────────
  const [showHourly, setShowHourly] = useState(true);
  const [showRecurring, setShowRecurring] = useState(true);
  const [showFixed, setShowFixed] = useState(true);
  const [showPayments, setShowPayments] = useState(true);
  const [selectedBar, setSelectedBar] = useState<string | null>(null);
  // Chart height is flex-driven (min 160px), bars use percentage heights

  // Recalculate max based on visible series
  const visibleMax = useMemo(() => {
    return Math.max(
      ...data.dailyBars.map(d => {
        let total = 0;
        if (showHourly) total += d.hourlyValue;
        if (showRecurring) total += d.recurringRevenue;
        if (showFixed) total += d.fixedRevenue;
        if (showPayments) total += d.paymentReceived;
        return total;
      }),
      1,
    );
  }, [data.dailyBars, showHourly, showRecurring, showFixed, showPayments]);

  const axisTicks = useMemo(() => niceAxisTicks(visibleMax), [visibleMax]);
  const axisMax = axisTicks[axisTicks.length - 1] || 1;

  const hasAnyChartData = useMemo(
    () => data.dailyBars.some(d => d.hourlyValue > 0 || d.fixedRevenue > 0 || d.recurringRevenue > 0 || d.paymentReceived > 0),
    [data.dailyBars],
  );

  // Track which categories have data so legend only shows relevant items
  const categoryHasData = useMemo(() => ({
    hourly: data.dailyBars.some(d => d.hourlyValue > 0),
    recurring: data.dailyBars.some(d => d.recurringRevenue > 0),
    fixed: data.dailyBars.some(d => d.fixedRevenue > 0),
    payments: data.dailyBars.some(d => d.paymentReceived > 0),
  }), [data.dailyBars]);

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
            </div>
          </div>

          <div className="px-5 py-3 overflow-x-auto">
            <div className="flex gap-6 lg:gap-8 min-w-max">
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Earned</p>
                <p className="text-sm font-semibold text-emerald-600">${fmt(data.totalEarned)}</p>
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
              <div className="flex items-center gap-2">
                <TrendingUp size={18} className="text-zinc-500" />
                <h2 className="font-semibold text-zinc-900">
                  {data.granularity === 'month' ? 'Monthly Earnings' : data.granularity === 'week' ? 'Weekly Earnings' : 'Daily Earnings'}
                </h2>
              </div>
              <span className="text-xs text-zinc-400 font-medium">{PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom range'}</span>
            </div>

            <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
              {(!showHourly && !showRecurring && !showFixed && !showPayments) ? (
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
                        const pct = axisMax > 0 ? ((axisMax - tick) / axisMax) * 100 : 0;
                        return (
                          <div
                            key={`grid-${tick}`}
                            className="absolute left-0 right-0 border-t border-zinc-100"
                            style={{ top: `${pct}%` }}
                          />
                        );
                      })}

                      {/* Bars */}
                      <div className="flex items-end gap-[3px] relative z-[1] h-full">
                        {data.dailyBars.map((day, barIdx) => {
                          const visibleHourly = showHourly ? day.hourlyValue : 0;
                          const visibleRecurring = showRecurring ? day.recurringRevenue : 0;
                          const visibleFixed = showFixed ? day.fixedRevenue : 0;
                          const visiblePayment = showPayments ? day.paymentReceived : 0;
                          const total = visibleHourly + visibleRecurring + visibleFixed + visiblePayment;
                          const hasData = total > 0;

                          const hourlyPct = axisMax > 0 ? (visibleHourly / axisMax) * 100 : 0;
                          const recurringPct = axisMax > 0 ? (visibleRecurring / axisMax) * 100 : 0;
                          const fixedPct = axisMax > 0 ? (visibleFixed / axisMax) * 100 : 0;
                          const paymentPct = axisMax > 0 ? (visiblePayment / axisMax) * 100 : 0;

                          const isSelected = selectedBar === day.dateKey;

                          // Figure out which segment is at the top so it gets rounded corners.
                          // Order top→bottom: payment, fixed, recurring, hourly.
                          const topIsPayment = visiblePayment > 0;
                          const topIsFixed = !topIsPayment && visibleFixed > 0;
                          const topIsRecurring = !topIsPayment && !topIsFixed && visibleRecurring > 0;

                          return (
                            <div
                              key={day.dateKey}
                              className="flex-1 flex flex-col justify-end group relative h-full cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedBar(isSelected ? null : day.dateKey);
                              }}
                            >
                              {hasData ? (
                                <>
                                  {visiblePayment > 0 && (
                                    <div
                                      className="w-full rounded-t bg-emerald-500 group-hover:bg-emerald-600 transition-colors duration-150"
                                      style={{ height: `${Math.max(paymentPct, 1.5)}%` }}
                                    />
                                  )}
                                  {visibleFixed > 0 && (
                                    <div
                                      className={`w-full bg-violet-500 group-hover:bg-violet-600 transition-colors duration-150 ${topIsFixed ? 'rounded-t' : ''}`}
                                      style={{ height: `${Math.max(fixedPct, 1.5)}%` }}
                                    />
                                  )}
                                  {visibleRecurring > 0 && (
                                    <div
                                      className={`w-full bg-amber-400 group-hover:bg-amber-500 transition-colors duration-150 ${topIsRecurring ? 'rounded-t' : ''}`}
                                      style={{ height: `${Math.max(recurringPct, 1.5)}%` }}
                                    />
                                  )}
                                  {visibleHourly > 0 && (
                                    <div
                                      className={`w-full bg-sky-400 group-hover:bg-sky-500 transition-colors duration-150 ${!topIsPayment && !topIsFixed && !topIsRecurring ? 'rounded-t' : ''}`}
                                      style={{ height: `${Math.max(hourlyPct, 1.5)}%` }}
                                    />
                                  )}
                                </>
                              ) : (
                                <div className="w-full rounded-t bg-zinc-100" style={{ height: 2 }} />
                              )}

                              {/* Tooltip - anchored just above the bar, edge-aware */}
                              {(visibleHourly > 0 || visibleFixed > 0 || visibleRecurring > 0 || visiblePayment > 0) && (() => {
                                const barCount = data.dailyBars.length;
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
                                const totalEarnedDay = visHourlyVal + visFixedVal + visRecurringVal;
                                const categoryCount = (visHourlyVal > 0 ? 1 : 0) + (visFixedVal > 0 ? 1 : 0) + (visRecurringVal > 0 ? 1 : 0);
                                const totalPct = hourlyPct + recurringPct + fixedPct + paymentPct;
                                // If the bar is too tall for the tooltip to fit above it,
                                // flip and anchor the tooltip to the top of the chart instead.
                                const flipBelow = totalPct > 65;
                                const posStyle: React.CSSProperties = flipBelow
                                  ? { top: 0 }
                                  : { bottom: `${Math.min(totalPct, 95)}%` };
                                const spacingCls = flipBelow ? 'mt-1' : 'mb-1';
                                return (
                                <div className={`absolute ${spacingCls} z-10 pointer-events-none ${isSelected ? 'block' : 'hidden group-hover:block'} ${alignCls}`} style={posStyle}>
                                  <div className="bg-zinc-900 text-white text-[10px] leading-relaxed px-2.5 py-1.5 rounded-md whitespace-nowrap shadow-lg">
                                    <p className="font-semibold text-zinc-200 mb-1">{day.tooltipDate}</p>
                                    {day.projectWork.length > 0 && (
                                      <div className="space-y-0.5">
                                        {day.projectWork.map((pw) => {
                                          const pwTotal = (showHourly ? pw.value : 0) + (showFixed ? pw.fixed : 0) + (showRecurring ? pw.recurring : 0);
                                          if (pwTotal === 0 && !(showHourly && pw.hours > 0)) return null;
                                          return (
                                            <div key={pw.projectId} className="flex items-center gap-1.5">
                                              {pw.color && (
                                                <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: pw.color }} />
                                              )}
                                              <span className="text-zinc-400">{pw.projectName}</span>
                                              {showHourly && pw.hours > 0 && <span className="text-zinc-200">{pw.hours.toFixed(1)}h</span>}
                                              <span className="font-semibold">${fmt(pwTotal)}</span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                    {totalEarnedDay > 0 && (day.projectWork.length > 1 || categoryCount > 1) && (
                                      <div className="mt-1 pt-1 border-t border-white/10 text-zinc-300 space-y-0.5">
                                        {visHourlyVal > 0 && (
                                          <div>Hourly: <span className="font-semibold">${fmt(visHourlyVal)}</span> <span className="text-zinc-400">({day.hoursWorked.toFixed(1)}h)</span></div>
                                        )}
                                        {visRecurringVal > 0 && (
                                          <div>Recurring: <span className="font-semibold">${fmt(visRecurringVal)}</span></div>
                                        )}
                                        {visFixedVal > 0 && (
                                          <div>Fixed: <span className="font-semibold">${fmt(visFixedVal)}</span></div>
                                        )}
                                        <div className="mt-1 pt-1 border-t border-white/10 flex items-center justify-between gap-3 text-zinc-100">
                                          <span className="uppercase tracking-wider text-[9px] text-zinc-400">Total earned</span>
                                          <span className="font-semibold">${fmt(totalEarnedDay)}</span>
                                        </div>
                                      </div>
                                    )}
                                    {visPaymentVal > 0 && (
                                      <p className="text-emerald-300 mt-0.5">Payments: <span className="font-semibold">${fmt(visPaymentVal)}</span></p>
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
                    {data.dailyBars.map((day, i) => {
                      const total = data.dailyBars.length;
                      // Aim for ~6 labels regardless of range length
                      const labelStep = Math.max(1, Math.floor(total / 6));
                      const showLabel = i === 0 || i === total - 1 || i % labelStep === 0;
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
              {(categoryHasData.hourly || categoryHasData.recurring || categoryHasData.fixed || categoryHasData.payments) && (
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
                            {isMulti ? `${items.length} items` : inv.invoice_type}
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
                      <span className="text-sm text-emerald-600 font-semibold text-right w-24">${fmt(p.earned)}</span>
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
                <span className="text-sm font-bold text-emerald-600 text-right w-24">${fmt(data.totalEarned)}</span>
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
                      <p className="text-sm font-semibold text-emerald-600">${fmt(p.earned)}</p>
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
      </div>
    </div>
  );
}
