'use client';

import { useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { Sparkline } from '@/components/ui/Sparkline';
import { DateInput } from '@/components/ui/inputs/DateInput';
import {
  computeAgentAnalytics,
  type AgentAnalyticsDay,
  type AgentAnalyticsRow,
} from '@/lib/agent-analytics';
import { toDateKey } from '@/lib/finance/vesting';
import { toLocalDateKey } from '@/lib/date-utils';
import { useAgentAnalyticsEvents } from '@/lib/use-agent-analytics-events';
import {
  BarChart3,
  Bot,
  CalendarRange,
  Check,
  ChevronDown,
  ClipboardCheck,
  Coins,
  DollarSign,
  FileDiff,
  FolderKanban,
  GitMerge,
  Timer,
  TrendingUp,
  Trophy,
  X,
  type LucideIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Formatting helpers (presentation only; every number comes from the read
// model in src/lib/agent-analytics.ts)
// ---------------------------------------------------------------------------

function fmt(value: number): string {
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
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

/** Token and line counts get compact units; small values stay exact. */
function fmtCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return value.toLocaleString('en-US');
}

function fmtDate(dateKey: string, withWeekday = false): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const month = date.toLocaleString('en-US', { month: 'short' });
  const base = y !== now.getFullYear() ? `${month} ${d}, ${y}` : `${month} ${d}`;
  if (!withWeekday) return base;
  return `${date.toLocaleString('en-US', { weekday: 'short' })}, ${base}`;
}

function fmtRangeDisplay(startKey: string, endKey: string): string {
  return `${fmtDate(startKey)} - ${fmtDate(endKey)}`;
}

// ---------------------------------------------------------------------------
// Date range presets (same vocabulary as the Finances page)
// ---------------------------------------------------------------------------

type RangePreset = '7d' | '30d' | '90d' | 'mtd' | 'all' | 'custom';

const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

function resolveRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  earliestDateKey: string | null,
  todayKey: string,
): { startKey: string; endKey: string } {
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const today = new Date(ty, tm - 1, td);
  const makeStart = (daysBack: number): string => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    return toDateKey(d);
  };
  switch (preset) {
    case '7d': return { startKey: makeStart(6), endKey: todayKey };
    case '30d': return { startKey: makeStart(29), endKey: todayKey };
    case '90d': return { startKey: makeStart(89), endKey: todayKey };
    case 'mtd': return { startKey: toDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), endKey: todayKey };
    case 'all': return { startKey: earliestDateKey ?? makeStart(89), endKey: todayKey };
    case 'custom': {
      if (customStart && customEnd) {
        return customStart <= customEnd
          ? { startKey: customStart, endKey: customEnd }
          : { startKey: customEnd, endKey: customStart };
      }
      return { startKey: makeStart(29), endKey: todayKey };
    }
  }
}

function daysBetween(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  return Math.round((new Date(ey, em - 1, ed).getTime() - new Date(sy, sm - 1, sd).getTime()) / 86400000) + 1;
}

type Granularity = 'day' | 'week' | 'month';

function pickGranularity(rangeDays: number): Granularity {
  if (rangeDays <= 90) return 'day';
  if (rangeDays <= 365) return 'week';
  return 'month';
}

/** Bucket-start key for a date at a granularity. Weeks align to Monday. */
function bucketStartKey(dateKey: string, gran: Granularity): string {
  if (gran === 'day') return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  if (gran === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  date.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
  return toDateKey(date);
}

function bucketLabel(startKey: string, gran: Granularity, todayKey: string): string {
  const [y, m, d] = startKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (gran === 'day' && startKey === todayKey) return 'Today';
  if (gran === 'month') {
    const base = date.toLocaleDateString('en-US', { month: 'short' });
    return y === new Date().getFullYear() ? base : `${base} ${String(y).slice(2)}`;
  }
  return `${date.toLocaleDateString('en-US', { month: 'short' })} ${d}`;
}

// ---------------------------------------------------------------------------
// Metrics: one vocabulary shared by the KPI tiles and the chart. Selecting a
// tile selects what the chart plots.
// ---------------------------------------------------------------------------

type ChartMetric = 'revenue' | 'modelCost' | 'profit' | 'runtime' | 'prsMerged' | 'linesChanged' | 'reviewRounds';

type MetricFormat = 'currency' | 'count' | 'duration';

const CHART_METRICS: { key: ChartMetric; label: string; format: MetricFormat; icon: LucideIcon }[] = [
  { key: 'revenue', label: 'Revenue', format: 'currency', icon: DollarSign },
  { key: 'modelCost', label: 'Model cost', format: 'currency', icon: Coins },
  { key: 'profit', label: 'Profit', format: 'currency', icon: TrendingUp },
  // Fleet capacity: how long the agents actually ran. Internal only, never billed.
  { key: 'runtime', label: 'Active runtime', format: 'duration', icon: Timer },
  { key: 'prsMerged', label: 'PRs merged', format: 'count', icon: GitMerge },
  { key: 'linesChanged', label: 'Lines changed', format: 'count', icon: FileDiff },
  { key: 'reviewRounds', label: 'Review rounds', format: 'count', icon: ClipboardCheck },
];

/** Untracked cost/profit days count as 0 on the chart; the tiles carry the
 * honest "Not tracked" state, the chart just needs a plottable series. */
function metricOf(day: AgentAnalyticsDay, metric: ChartMetric): number {
  switch (metric) {
    case 'revenue': return day.revenue;
    case 'modelCost': return day.modelCost ?? 0;
    case 'profit': return day.profit ?? 0;
    case 'runtime': return day.runtimeMs ?? 0;
    case 'prsMerged': return day.prsMerged;
    case 'linesChanged': return day.linesChanged;
    case 'reviewRounds': return day.reviewRounds;
  }
}

/** Runtime reads in hours and minutes; milliseconds are a storage detail. */
function fmtDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** ~4 rounded axis ticks from 0 to just past maxVal. Integer steps for counts. */
function axisTicks(maxVal: number, format: MetricFormat): number[] {
  if (maxVal <= 0) return [0];
  // Durations tick in whole minutes or hours rather than arbitrary round
  // milliseconds, which would label an axis "1.5M".
  if (format === 'duration') {
    const unit = maxVal >= 4 * 3_600_000 ? 3_600_000 : 60_000;
    const steps = Math.max(1, Math.ceil(maxVal / unit / 4));
    const step = steps * unit;
    const ticks: number[] = [0];
    let v = step;
    while (v < maxVal * 1.05) { ticks.push(v); v += step; }
    ticks.push(v);
    return ticks;
  }
  if (format === 'count' && maxVal <= 4) {
    return Array.from({ length: Math.ceil(maxVal) + 1 }, (_, i) => i);
  }
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / mag;
  let step: number;
  if (residual <= 1.5) step = mag;
  else if (residual <= 3.5) step = 2 * mag;
  else if (residual <= 7.5) step = 5 * mag;
  else step = 10 * mag;
  if (format === 'count') step = Math.max(1, Math.round(step));
  const ticks: number[] = [0];
  let v = step;
  while (v <= maxVal * 1.05) { ticks.push(v); v += step; }
  if (ticks[ticks.length - 1] < maxVal) ticks.push(v);
  return ticks;
}

function fmtAxis(value: number, format: MetricFormat): string {
  if (format === 'duration') return value === 0 ? '0' : fmtDuration(value);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const prefix = format === 'currency' ? '$' : '';
  if (value === 0) return `${prefix}0`;
  if (abs >= 1000) return `${sign}${prefix}${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}K`;
  const rounded = Math.round(abs * 100) / 100;
  return `${sign}${prefix}${rounded}`;
}

// Same vivid family as the Finances chart, one hue per agent. Assigned by
// roster order so an agent keeps its color across filters and visits.
const AGENT_SERIES = [
  { bar: 'bg-sky-400', hover: 'group-hover:bg-sky-500', dot: 'bg-sky-400' },
  { bar: 'bg-violet-500', hover: 'group-hover:bg-violet-600', dot: 'bg-violet-500' },
  { bar: 'bg-amber-400', hover: 'group-hover:bg-amber-500', dot: 'bg-amber-400' },
  { bar: 'bg-emerald-500', hover: 'group-hover:bg-emerald-600', dot: 'bg-emerald-500' },
  { bar: 'bg-rose-400', hover: 'group-hover:bg-rose-500', dot: 'bg-rose-400' },
  { bar: 'bg-teal-500', hover: 'group-hover:bg-teal-600', dot: 'bg-teal-500' },
];

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** The one way a missing measurement renders. Never a fake zero. */
function NotTracked({ reason, className = '' }: { reason: string; className?: string }) {
  return (
    <Tooltip content={<span className="block max-w-[260px] whitespace-normal">{reason}</span>}>
      <span className={`font-medium text-zinc-500 cursor-help ${className}`}>Not tracked</span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentAnalyticsPage() {
  const { agentActivity: recentActivity, timeEntries, team, projects } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find(member => member.id === teamMemberId);
  const preferredTimezone = currentMember?.timezone && currentMember.timezone !== 'UTC'
    ? currentMember.timezone
    : undefined;

  // A static "now" per mount: analytics is a report, not a live ticker.
  const [now] = useState(() => Date.now());
  const todayKey = toLocalDateKey(new Date(now).toISOString(), preferredTimezone);

  // ── Filters ─────────────────────────────────────────────────
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement>(null);

  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [projectOpen, setProjectOpen] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [agentOpen, setAgentOpen] = useState(false);
  const agentRef = useRef<HTMLDivElement>(null);

  const [chartMetric, setChartMetric] = useState<ChartMetric>('revenue');

  // The labels row mirrors the bars' horizontal scroll on mobile so labels
  // stay aligned to their bars.
  const barsScrollRef = useRef<HTMLDivElement>(null);
  const labelsScrollRef = useRef<HTMLDivElement>(null);

  const roster = useMemo(
    () => team.filter(m => m.role === 'agent').slice().sort((a, b) => a.name.localeCompare(b.name)),
    [team],
  );
  const seriesByAgent = useMemo(
    () => new Map(roster.map((m, i) => [m.id, AGENT_SERIES[i % AGENT_SERIES.length]])),
    [roster],
  );

  const earliestDateKey = useMemo(() => {
    let earliest: string | null = null;
    for (const a of recentActivity) {
      const k = toLocalDateKey(a.created_at, preferredTimezone);
      if (!earliest || k < earliest) earliest = k;
    }
    const agentIds = new Set(roster.map(m => m.id));
    for (const te of timeEntries) {
      if (!agentIds.has(te.member_id)) continue;
      const k = toLocalDateKey(te.start_time, preferredTimezone);
      if (!earliest || k < earliest) earliest = k;
    }
    return earliest;
  }, [recentActivity, timeEntries, roster, preferredTimezone]);

  const range = useMemo(
    () => resolveRange(preset, customStart, customEnd, earliestDateKey, todayKey),
    [preset, customStart, customEnd, earliestDateKey, todayKey],
  );

  // A report reads its whole range from the database rather than the store's
  // recent-activity window, which is deliberately small and excludes telemetry.
  const events = useAgentAnalyticsEvents(range, recentActivity);
  const agentActivity = events.rows;

  // ── Read model ──────────────────────────────────────────────
  const analytics = useMemo(
    () => computeAgentAnalytics({
      activities: agentActivity,
      timeEntries,
      team,
      projects,
      range,
      now,
      timezone: preferredTimezone,
      selectedAgentIds: selectedAgentIds.size > 0 ? selectedAgentIds : undefined,
      selectedProjectIds: selectedProjectIds.size > 0 ? selectedProjectIds : undefined,
    }),
    [agentActivity, timeEntries, team, projects, range, now, preferredTimezone, selectedAgentIds, selectedProjectIds],
  );

  // Which telemetry streams have EVER reported. A stream that has never
  // reported renders as "Not tracked"; a stream that reports zero renders 0.
  const telemetry = useMemo(() => ({
    handoff: agentActivity.some(a => a.activity_type === 'work.handoff'),
    merged: agentActivity.some(a => a.activity_type === 'pr.merged'),
    usage: agentActivity.some(a => a.activity_type === 'usage.recorded'),
    runtime: agentActivity.some(a => a.activity_type === 'turn.completed'),
  }), [agentActivity]);

  const summary = useMemo(() => {
    const rows = analytics.agents;
    const sum = (pick: (r: AgentAnalyticsRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
    const trackedRows = rows.filter(r => r.modelCost.tracking === 'tracked');
    const trackedSum = (pick: (r: AgentAnalyticsRow) => number | null) =>
      trackedRows.reduce((s, r) => s + (pick(r) ?? 0), 0);
    const usageTracked = trackedRows.length > 0;
    // Profit needs a cost for every agent that produced revenue; a partial
    // cost picture would overstate it.
    const profitTracked = usageTracked
      && rows.every(r => r.modelCost.tracking === 'tracked' || r.revenue === 0);
    return {
      prsOpened: sum(r => r.prsOpened),
      prsMerged: sum(r => r.prsMerged),
      reviewRounds: sum(r => r.reviewRounds),
      additions: sum(r => r.additions),
      deletions: sum(r => r.deletions),
      linesChanged: sum(r => r.linesChanged),
      revenue: sum(r => r.revenue),
      hours: sum(r => r.hours),
      inputTokens: usageTracked ? trackedSum(r => r.inputTokens.value) : null,
      outputTokens: usageTracked ? trackedSum(r => r.outputTokens.value) : null,
      cachedTokens: usageTracked ? trackedSum(r => r.cachedTokens.value) : null,
      modelCost: usageTracked ? trackedSum(r => r.modelCost.value) : null,
      profit: profitTracked ? sum(r => r.revenue) - trackedSum(r => r.modelCost.value) : null,
      usagePartial: usageTracked && trackedRows.length < rows.length,
      usageAgents: trackedRows.length,
      totalAgents: rows.length,
      runtimeMs: rows.some(r => r.runtimeMs.tracking === 'tracked')
        ? rows.reduce((s, r) => s + (r.runtimeMs.value ?? 0), 0)
        : null,
      productiveRuntimeMs: rows.some(r => r.productiveRuntimeMs.tracking === 'tracked')
        ? rows.reduce((s, r) => s + (r.productiveRuntimeMs.value ?? 0), 0)
        : null,
      turns: sum(r => r.turns),
    };
  }, [analytics]);

  const usageReason = selectedAgentIds.size > 0 || selectedProjectIds.size > 0
    ? 'Hermes usage telemetry has not reported for this selection.'
    : 'Hermes usage telemetry has not reported yet. Token and cost figures appear once usage events are recorded.';
  const mergeReason = 'Merge telemetry has not reported yet. Counts appear once merged pull requests are recorded.';
  const runtimeReason = selectedProjectIds.size > 0
    ? 'Runtime is fleet-wide, not per project: a turn can touch several projects or none, so it is not attributed to a project filter.'
    : 'Turn telemetry has not reported yet. Runtime appears once completed turns are recorded.';
  const profitReason = telemetry.usage
    ? 'Model cost is missing for at least one agent with revenue in this selection, so profit would be overstated.'
    : usageReason;

  // ── KPI tile model ──────────────────────────────────────────
  // Per-day totals across the range, one series per metric, feeding each
  // tile's sparkline. Days without data plot as 0 so the line spans the range.
  const sparkSeries = useMemo(() => {
    const rangeDays = daysBetween(range.startKey, range.endKey);
    const [sy, sm, sd] = range.startKey.split('-').map(Number);
    const cursor = new Date(sy, sm - 1, sd);
    const index = new Map<string, number>();
    for (let i = 0; i < rangeDays; i++) {
      index.set(toDateKey(cursor), i);
      cursor.setDate(cursor.getDate() + 1);
    }
    const series: Record<ChartMetric, number[]> = {
      revenue: Array(rangeDays).fill(0),
      modelCost: Array(rangeDays).fill(0),
      profit: Array(rangeDays).fill(0),
      runtime: Array(rangeDays).fill(0),
      prsMerged: Array(rangeDays).fill(0),
      linesChanged: Array(rangeDays).fill(0),
      reviewRounds: Array(rangeDays).fill(0),
    };
    for (const day of analytics.daily) {
      const i = index.get(day.dateKey);
      if (i === undefined) continue;
      for (const metric of Object.keys(series) as ChartMetric[]) {
        series[metric][i] += metricOf(day, metric);
      }
    }
    return series;
  }, [analytics.daily, range]);

  // What each tile shows: the value slot (null = not tracked), a context
  // line, and whether the sparkline is meaningful.
  const tiles = useMemo(() => {
    const marginPct = summary.profit !== null && summary.revenue > 0
      ? Math.round((summary.profit / summary.revenue) * 100)
      : null;
    return CHART_METRICS.map(metric => {
      switch (metric.key) {
        case 'revenue': return {
          ...metric,
          value: fmtCurrency(summary.revenue),
          valueClass: 'text-white',
          context: `${fmt(summary.hours)} hrs billed`,
          notTracked: null,
        };
        case 'modelCost': return {
          ...metric,
          value: summary.modelCost !== null ? fmtCurrency(summary.modelCost) : null,
          valueClass: 'text-amber-400',
          context: summary.modelCost !== null
            ? `In ${fmtCount(summary.inputTokens ?? 0)} · Out ${fmtCount(summary.outputTokens ?? 0)}`
            : 'Awaiting Hermes telemetry',
          notTracked: usageReason,
        };
        case 'profit': return {
          ...metric,
          value: summary.profit !== null ? fmtCurrency(summary.profit) : null,
          valueClass: summary.profit !== null && summary.profit < 0 ? 'text-red-400' : 'text-emerald-400',
          context: marginPct !== null ? `${marginPct}% margin` : 'Revenue minus model cost',
          notTracked: profitReason,
        };
        case 'runtime': {
          // The capacity trend: how long the fleet ran. Productive share is the
          // context because runtime spent finding nothing is real time but not
          // real output, and the gap between them is the useful signal.
          const productivePct = summary.runtimeMs && summary.runtimeMs > 0 && summary.productiveRuntimeMs !== null
            ? Math.round((summary.productiveRuntimeMs / summary.runtimeMs) * 100)
            : null;
          return {
            ...metric,
            value: summary.runtimeMs !== null ? fmtDuration(summary.runtimeMs) : null,
            valueClass: 'text-sky-300',
            context: productivePct !== null
              ? `${productivePct}% productive · ${summary.turns.toLocaleString('en-US')} turns`
              : 'Time the agents actually ran',
            notTracked: selectedProjectIds.size > 0
              ? 'Runtime is fleet-wide, not per project: a turn can touch several projects or none, so it is not attributed to a project filter.'
              : 'Turn telemetry has not reported yet. Runtime appears once completed turns are recorded.',
          };
        }
        case 'prsMerged': return {
          ...metric,
          value: telemetry.merged ? summary.prsMerged.toLocaleString('en-US') : null,
          valueClass: 'text-white',
          context: telemetry.handoff
            ? `${summary.prsOpened.toLocaleString('en-US')} opened`
            : 'Merged pull requests',
          notTracked: mergeReason,
        };
        case 'linesChanged': return {
          ...metric,
          value: telemetry.merged ? fmtCount(summary.linesChanged) : null,
          valueClass: 'text-white',
          context: telemetry.merged
            ? `+${fmtCount(summary.additions)} / -${fmtCount(summary.deletions)}`
            : 'From merged pull requests',
          notTracked: 'Line counts arrive with merge telemetry, which has not reported yet.',
        };
        case 'reviewRounds': return {
          ...metric,
          value: summary.reviewRounds.toLocaleString('en-US'),
          valueClass: 'text-white',
          context: 'Review cycles in range',
          notTracked: null,
        };
      }
    });
  }, [summary, telemetry, usageReason, profitReason, mergeReason, selectedProjectIds]);

  const metricConfig = CHART_METRICS.find(m => m.key === chartMetric)!;

  // ── Chart data ──────────────────────────────────────────────
  const chart = useMemo(() => {
    const rangeDays = daysBetween(range.startKey, range.endKey);
    const granularity = pickGranularity(rangeDays);

    interface Bar {
      startKey: string;
      label: string;
      perAgent: Map<string, number>;
      total: number;
      posTotal: number;
      negTotal: number;
      /** Bucket model cost for the revenue overlay; null = no tracked day. */
      cost: number | null;
    }
    const order: string[] = [];
    const buckets = new Map<string, Bar>();
    const [sy, sm, sd] = range.startKey.split('-').map(Number);
    const startDate = new Date(sy, sm - 1, sd);
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const bStart = bucketStartKey(toDateKey(d), granularity);
      if (!buckets.has(bStart)) {
        order.push(bStart);
        buckets.set(bStart, {
          startKey: bStart,
          label: bucketLabel(bStart, granularity, todayKey),
          perAgent: new Map(),
          total: 0,
          posTotal: 0,
          negTotal: 0,
          cost: null,
        });
      }
    }
    for (const day of analytics.daily) {
      const bucket = buckets.get(bucketStartKey(day.dateKey, granularity));
      if (!bucket) continue;
      const value = metricOf(day, chartMetric);
      // Profit is the one signed metric; everything else never goes negative.
      if (value !== 0) {
        bucket.perAgent.set(day.agentId, (bucket.perAgent.get(day.agentId) ?? 0) + value);
        bucket.total += value;
      }
      if (day.modelCost !== null) bucket.cost = (bucket.cost ?? 0) + day.modelCost;
    }
    for (const bucket of buckets.values()) {
      for (const value of bucket.perAgent.values()) {
        if (value > 0) bucket.posTotal += value;
        else bucket.negTotal += value;
      }
    }
    const bars = order.map(k => buckets.get(k)!);
    const posMax = Math.max(...bars.map(b => b.posTotal), 0);
    const negMin = Math.min(...bars.map(b => b.negTotal), 0);
    return { bars, posMax, negMin, granularity };
  }, [analytics.daily, chartMetric, range, todayKey]);

  // Axis with an optional negative region below the zero line (profit only).
  const ticks = useMemo(() => {
    const positive = axisTicks(Math.max(chart.posMax, 1), metricConfig.format);
    if (chart.negMin >= 0) return positive;
    const negative = axisTicks(Math.abs(chart.negMin), metricConfig.format)
      .slice(1)
      .map(v => -v)
      .reverse();
    return [...negative, ...positive];
  }, [chart.posMax, chart.negMin, metricConfig.format]);
  const axisMin = Math.min(0, ticks[0] ?? 0);
  const axisMax = Math.max(ticks[ticks.length - 1] ?? 1, 1);
  const axisRange = axisMax - axisMin;
  const zeroBottomPct = (Math.abs(axisMin) / axisRange) * 100;
  const positiveAreaPct = (axisMax / axisRange) * 100;
  const negativeAreaPct = (Math.abs(axisMin) / axisRange) * 100;
  const hasChartData = chart.bars.some(b => b.posTotal > 0 || b.negTotal < 0);

  // Model-cost overlay: only over the revenue chart, and only when usage has
  // reported. Contiguous tracked buckets form polyline runs; untracked
  // buckets break the line rather than faking a zero.
  const showCostOverlay = chartMetric === 'revenue' && telemetry.usage && hasChartData;
  const costRuns = useMemo(() => {
    if (!showCostOverlay) return [];
    const n = chart.bars.length;
    const runs: string[][] = [];
    let current: string[] = [];
    chart.bars.forEach((bar, i) => {
      if (bar.cost === null) {
        if (current.length > 0) { runs.push(current); current = []; }
        return;
      }
      const x = ((i + 0.5) / n) * 100;
      const y = 100 - zeroBottomPct - (Math.min(bar.cost, axisMax) / axisMax) * positiveAreaPct;
      current.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    });
    if (current.length > 0) runs.push(current);
    // A run of one point still needs two points to draw; round linecaps turn
    // the degenerate segment into a visible dot.
    return runs.map(run => (run.length === 1 ? [run[0], run[0]] : run).join(' '));
  }, [showCostOverlay, chart.bars, zeroBottomPct, positiveAreaPct, axisMax]);

  const focusedAgent = selectedAgentIds.size === 1
    ? roster.find(m => selectedAgentIds.has(m.id)) ?? null
    : null;

  const toggleFocus = (agentId: string) => {
    setSelectedAgentIds(prev =>
      prev.size === 1 && prev.has(agentId) ? new Set() : new Set([agentId]),
    );
  };

  // Legend and stacking follow the roster subset that the filter allows.
  const chartAgents = useMemo(
    () => roster.filter(m => selectedAgentIds.size === 0 || selectedAgentIds.has(m.id)),
    [roster, selectedAgentIds],
  );

  const noTelemetryForMetric =
    (chartMetric === 'prsMerged' || chartMetric === 'linesChanged') && !telemetry.merged
      ? 'Merge telemetry has not reported yet. This chart fills in once merged pull requests are recorded.'
      : (chartMetric === 'modelCost' || chartMetric === 'profit') && !telemetry.usage
        ? usageReason
        : null;

  const fmtValue = (v: number) => metricConfig.format === 'currency'
    ? fmtCurrency(v)
    : metricConfig.format === 'duration' ? fmtDuration(v) : fmtCount(v);

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Agent Analytics"
        subtitle={<span className="hidden sm:inline">Delivery, cost, and revenue per agent. Only measured data; nothing is estimated.</span>}
      />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {/* ── Overview bar: identical structure and responsive behavior
            to the Finances Overview card header (title cluster left,
            range text + wrapping dropdowns right; below sm the range text
            hides and buttons share the full width). */}
        <div className="glass-card rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <BarChart3 size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
            <h2 className="font-semibold text-white">Overview</h2>
            {focusedAgent && (
              <span className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-brand-500/15 text-brand-300 text-xs font-medium">
                <Avatar name={focusedAgent.name} src={focusedAgent.avatar || undefined} size="xs" />
                <span className="truncate max-w-[120px]">{focusedAgent.name}</span>
                <button
                  type="button"
                  onClick={() => setSelectedAgentIds(new Set())}
                  className="rounded-full p-0.5 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
                  aria-label={`Stop focusing on ${focusedAgent.name}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            <span className="hidden sm:inline text-xs text-zinc-500 font-medium">
              {fmtRangeDisplay(range.startKey, range.endKey)}
            </span>
            {/* Date range */}
            <div ref={rangeRef} className="relative flex-1 sm:flex-none">
              <button
                type="button"
                onClick={() => setRangeOpen(o => !o)}
                aria-expanded={rangeOpen}
                aria-haspopup="menu"
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
              >
                <CalendarRange size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
                <span className="text-xs font-medium text-zinc-300 whitespace-nowrap">
                  {PRESET_OPTIONS.find(o => o.value === preset)?.label ?? 'Custom'}
                </span>
                <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${rangeOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              <Popover
                anchorRef={rangeRef}
                open={rangeOpen}
                onClose={() => setRangeOpen(false)}
                align="end"
                ignoreOutsideSelector='[role="dialog"][aria-label="Date picker"]'
                className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
              >
                <div className="p-1">
                  {PRESET_OPTIONS.map(opt => {
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
                          active ? 'bg-brand-500/15 text-brand-300 font-medium' : 'text-zinc-300 hover:bg-white/[0.03]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {preset === 'custom' && (
                  <div className="border-t border-white/[0.06] bg-white/[0.03] p-3 space-y-2">
                    <DateInput
                      label="Start date"
                      value={customStart}
                      onChange={setCustomStart}
                      size="sm"
                      minDate={earliestDateKey ?? undefined}
                      maxDate={customEnd && customEnd < todayKey ? customEnd : todayKey}
                      clearable
                    />
                    <DateInput
                      label="End date"
                      value={customEnd}
                      onChange={setCustomEnd}
                      size="sm"
                      minDate={customStart || earliestDateKey || undefined}
                      maxDate={todayKey}
                      clearable
                    />
                  </div>
                )}
              </Popover>
            </div>

            {/* Project filter */}
            {(() => {
              const filterable = projects
                .filter(p => p.status !== 'archived')
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
              const count = selectedProjectIds.size;
              const label = count === 0
                ? 'All projects'
                : count === 1
                  ? (projects.find(p => selectedProjectIds.has(p.id))?.name ?? '1 project')
                  : `${count} projects`;
              return (
                <div ref={projectRef} className="relative flex-1 sm:flex-none">
                  <button
                    type="button"
                    onClick={() => setProjectOpen(o => !o)}
                    aria-expanded={projectOpen}
                    aria-haspopup="menu"
                    className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
                  >
                    <FolderKanban size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs font-medium text-zinc-300 truncate max-w-[140px]">{label}</span>
                    <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${projectOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  <Popover
                    anchorRef={projectRef}
                    open={projectOpen}
                    onClose={() => setProjectOpen(false)}
                    align="end"
                    className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
                  >
                    <div className="px-2.5 py-2 border-b border-white/[0.06] flex items-center justify-between gap-6">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Projects</span>
                      <button
                        type="button"
                        onClick={() => setSelectedProjectIds(new Set())}
                        disabled={count === 0}
                        className="text-[11px] font-medium text-zinc-400 hover:text-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-[320px] overflow-y-auto py-1">
                      {filterable.length === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-zinc-500">No active projects</p>
                      ) : filterable.map(p => {
                        const checked = selectedProjectIds.has(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={checked}
                            onClick={() => setSelectedProjectIds(prev => {
                              const next = new Set(prev);
                              if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                              return next;
                            })}
                            className="w-full text-left text-sm px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors flex items-center gap-2"
                          >
                            <span className={`flex items-center justify-center w-4 h-4 rounded border transition-colors flex-shrink-0 ${
                              checked ? 'bg-brand-600 border-brand-600 text-white' : 'border-white/[0.12] bg-surface-raised'
                            }`}>
                              {checked && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                            </span>
                            {p.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} aria-hidden="true" />}
                            <span className="text-zinc-300 truncate flex-1 min-w-0">{p.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </Popover>
                </div>
              );
            })()}

            {/* Agent filter */}
            {(() => {
              const count = selectedAgentIds.size;
              const label = count === 0
                ? 'All agents'
                : count === 1
                  ? (roster.find(m => selectedAgentIds.has(m.id))?.name ?? '1 agent')
                  : `${count} agents`;
              return (
                <div ref={agentRef} className="relative flex-1 sm:flex-none">
                  <button
                    type="button"
                    onClick={() => setAgentOpen(o => !o)}
                    aria-expanded={agentOpen}
                    aria-haspopup="menu"
                    className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
                  >
                    <Bot size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs font-medium text-zinc-300 truncate max-w-[140px]">{label}</span>
                    <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${agentOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  <Popover
                    anchorRef={agentRef}
                    open={agentOpen}
                    onClose={() => setAgentOpen(false)}
                    align="end"
                    className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden"
                  >
                    <div className="px-2.5 py-2 border-b border-white/[0.06] flex items-center justify-between gap-6">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Agents</span>
                      <button
                        type="button"
                        onClick={() => setSelectedAgentIds(new Set())}
                        disabled={count === 0}
                        className="text-[11px] font-medium text-zinc-400 hover:text-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-[320px] overflow-y-auto py-1">
                      {roster.length === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-zinc-500">No agent team members</p>
                      ) : roster.map(m => {
                        const checked = selectedAgentIds.has(m.id);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={checked}
                            onClick={() => setSelectedAgentIds(prev => {
                              const next = new Set(prev);
                              if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                              return next;
                            })}
                            className="w-full text-left text-sm px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors flex items-center gap-2"
                          >
                            <span className={`flex items-center justify-center w-4 h-4 rounded border transition-colors flex-shrink-0 ${
                              checked ? 'bg-brand-600 border-brand-600 text-white' : 'border-white/[0.12] bg-surface-raised'
                            }`}>
                              {checked && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                            </span>
                            <Avatar name={m.name} src={m.avatar || undefined} size="xs" />
                            <span className="text-zinc-300 truncate flex-1 min-w-0">{m.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </Popover>
                </div>
              );
            })()}
          </div>
        </div>

        {/* ── KPI tiles: one per metric, selection drives the chart ── */}
        <div className="flex overflow-x-auto gap-3 lg:grid lg:grid-cols-3 xl:grid-cols-6 lg:gap-4 -mx-4 px-4 lg:mx-0 lg:px-0 scrollbar-none">
          {tiles.map(tile => {
            const selected = chartMetric === tile.key;
            const Icon = tile.icon;
            const spark = sparkSeries[tile.key];
            const showSpark = tile.value !== null && spark.some(v => v !== 0);
            return (
              <button
                key={tile.key}
                type="button"
                onClick={() => setChartMetric(tile.key)}
                aria-pressed={selected}
                className={`min-w-[190px] flex-shrink-0 lg:min-w-0 glass-card rounded-xl p-4 lg:p-5 text-left cursor-pointer transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  selected ? 'ring-1 ring-brand-500/40' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs lg:text-sm text-zinc-500 font-medium">{tile.label}</p>
                    {tile.value !== null ? (
                      <p className={`text-2xl lg:text-3xl font-bold tracking-tight mt-1.5 leading-none ${tile.valueClass}`}>
                        {tile.value}
                      </p>
                    ) : (
                      <div className="mt-1.5">
                        <NotTracked className="text-base" reason={tile.notTracked ?? usageReason} />
                      </div>
                    )}
                  </div>
                  <div className="w-8 h-8 lg:w-9 lg:h-9 rounded-lg grid place-items-center bg-white/[0.06] text-zinc-400 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] flex-shrink-0">
                    <Icon size={16} aria-hidden="true" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-3.5 min-h-[22px]">
                  <span className="text-xs text-zinc-500 truncate">{tile.context}</span>
                  {showSpark && (
                    <Sparkline data={spark} className={selected ? 'text-brand-400 flex-shrink-0' : 'text-zinc-500 flex-shrink-0'} />
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Main chart, driven by the selected tile ────────── */}
        <div className="glass-card rounded-xl overflow-hidden flex flex-col min-h-[380px]">
          <div className="px-5 py-4 flex items-center justify-between gap-3 border-b border-white/[0.06] flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <TrendingUp size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
              <h2 className="font-semibold text-white truncate">
                {chart.granularity === 'month' ? 'Monthly' : chart.granularity === 'week' ? 'Weekly' : 'Daily'} {metricConfig.label.toLowerCase()}
              </h2>
            </div>
            <span className="text-xs text-zinc-500 font-medium hidden sm:inline flex-shrink-0">
              Stacked by agent
            </span>
          </div>

          <div className="chart-vivid px-5 pt-5 pb-4 flex-1 flex flex-col">
            {!hasChartData ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
                <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
                  <TrendingUp size={18} className="text-zinc-500" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-zinc-400">
                  {noTelemetryForMetric ? 'Not tracked yet' : `No ${metricConfig.label.toLowerCase()} in this range`}
                </p>
                <p className="text-xs text-zinc-500 mt-1 max-w-[360px]">
                  {noTelemetryForMetric ?? 'Try a wider date range, or clear the project and agent filters.'}
                </p>
              </div>
            ) : (
              <>
                <div className="flex gap-0 flex-1 min-h-[160px]">
                  {/* Y axis */}
                  <div className="flex flex-col justify-between flex-shrink-0 pr-2">
                    {[...ticks].reverse().map(tick => (
                      <span key={tick} className="text-[10px] text-zinc-500 font-medium leading-none text-right" style={{ minWidth: 36 }}>
                        {fmtAxis(tick, metricConfig.format)}
                      </span>
                    ))}
                  </div>

                  {/* Bars */}
                  <div className="flex-1 relative min-w-0">
                    {ticks.map(tick => (
                      <div
                        key={`grid-${tick}`}
                        className={`absolute left-0 right-0 border-t ${tick === 0 && axisMin < 0 ? 'border-white/[0.15]' : 'border-white/[0.06]'}`}
                        style={{ top: `${((axisMax - tick) / axisRange) * 100}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    <div
                      ref={barsScrollRef}
                      onScroll={(e) => {
                        if (labelsScrollRef.current) labelsScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
                      }}
                      className="absolute inset-0 overflow-x-auto sm:overflow-visible no-scrollbar"
                    >
                      <div
                        className="chart-scroll-content flex items-end gap-[3px] relative z-[1] h-full"
                        style={{ '--bar-count': chart.bars.length } as React.CSSProperties}
                      >
                        {showCostOverlay && costRuns.length > 0 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            className="absolute inset-0 z-[2] pointer-events-none text-amber-400"
                            aria-hidden="true"
                          >
                            {costRuns.map((points, i) => (
                              <polyline
                                key={i}
                                points={points}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={1.5}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                          </svg>
                        )}
                        {chart.bars.map((bar, barIdx) => {
                          const segments = chartAgents
                            .map(m => ({ member: m, value: bar.perAgent.get(m.id) ?? 0 }))
                            .filter(s => s.value !== 0);
                          const posSegments = segments.filter(s => s.value > 0);
                          const negSegments = segments.filter(s => s.value < 0);
                          const posBarPct = axisMax > 0 ? (bar.posTotal / axisMax) * positiveAreaPct : 0;
                          const negBarPct = axisMin < 0 ? (Math.abs(bar.negTotal) / Math.abs(axisMin)) * negativeAreaPct : 0;
                          const barCount = chart.bars.length;
                          const edgeZone = Math.max(4, Math.floor(barCount / 3));
                          const alignCls = barIdx < edgeZone
                            ? 'left-0'
                            : barIdx >= barCount - edgeZone
                              ? 'right-0'
                              : 'left-1/2 -translate-x-1/2';
                          const tooltipAnchorPct = zeroBottomPct + posBarPct;
                          const flipBelow = tooltipAnchorPct > 65;
                          const ariaLabel = segments.length > 0
                            ? `${bar.label}: ${segments.map(s => `${s.member.name} ${fmtValue(s.value)}`).join(', ')}`
                            : `${bar.label}: none`;
                          return (
                            <div
                              key={bar.startKey}
                              role="img"
                              aria-label={ariaLabel}
                              className="flex-1 flex flex-col justify-end group relative h-full"
                            >
                              {posSegments.length > 0 && (
                                <>
                                  <div
                                    className="absolute inset-x-0 flex flex-col-reverse"
                                    style={{ bottom: `${zeroBottomPct}%`, height: `${Math.max(posBarPct, posSegments.length * 1.5)}%` }}
                                  >
                                    {posSegments.map((s, i) => {
                                      const series = seriesByAgent.get(s.member.id) ?? AGENT_SERIES[0];
                                      const isTop = i === posSegments.length - 1;
                                      return (
                                        <div
                                          key={s.member.id}
                                          className={`w-full ${series.bar} ${series.hover} transition-colors duration-150 ${isTop ? 'rounded-t' : ''}`}
                                          style={{ height: `${Math.max((s.value / Math.max(bar.posTotal, 0.0001)) * 100, 3)}%` }}
                                        />
                                      );
                                    })}
                                  </div>
                                  <div
                                    className="chart-bar pointer-events-none absolute inset-x-0 rounded-t overflow-hidden"
                                    style={{ bottom: `${zeroBottomPct}%`, height: `${Math.max(posBarPct, posSegments.length * 1.5)}%` }}
                                    aria-hidden="true"
                                  />
                                </>
                              )}
                              {negSegments.length > 0 && (
                                <div
                                  className="absolute inset-x-0 flex flex-col"
                                  style={{ top: `${100 - zeroBottomPct}%`, height: `${Math.max(negBarPct, negSegments.length * 1.5)}%` }}
                                >
                                  {negSegments.map((s, i) => {
                                    const series = seriesByAgent.get(s.member.id) ?? AGENT_SERIES[0];
                                    const isBottom = i === negSegments.length - 1;
                                    return (
                                      <div
                                        key={s.member.id}
                                        className={`w-full opacity-60 ${series.bar} ${series.hover} transition-colors duration-150 ${isBottom ? 'rounded-b' : ''}`}
                                        style={{ height: `${Math.max((Math.abs(s.value) / Math.max(Math.abs(bar.negTotal), 0.0001)) * 100, 3)}%` }}
                                      />
                                    );
                                  })}
                                </div>
                              )}
                              {segments.length === 0 && (
                                <div className="absolute inset-x-0 bg-white/[0.06]" style={{ bottom: `${zeroBottomPct}%`, height: 2 }} aria-hidden="true" />
                              )}

                              {segments.length > 0 && (
                                <div
                                  className={`absolute z-10 pointer-events-none hidden group-hover:block ${alignCls} ${flipBelow ? 'mt-1' : 'mb-1'}`}
                                  style={flipBelow ? { top: 0 } : { bottom: `${Math.min(tooltipAnchorPct, 95)}%` }}
                                >
                                  <div className="bg-surface-overlay border border-white/[0.08] text-white text-[10px] leading-relaxed px-2.5 py-1.5 rounded-md whitespace-nowrap shadow-lg">
                                    <p className="font-semibold text-zinc-200 mb-1">{bar.label === 'Today' ? fmtDate(bar.startKey, true) : bar.label}</p>
                                    <div className="space-y-0.5">
                                      {segments.slice().reverse().map(s => {
                                        const series = seriesByAgent.get(s.member.id) ?? AGENT_SERIES[0];
                                        return (
                                          <div key={s.member.id} className="flex items-center gap-1.5">
                                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${series.dot}`} aria-hidden="true" />
                                            <span className="text-zinc-400 flex-1 min-w-0 pr-3">{s.member.name}</span>
                                            <span className={`font-semibold ${s.value < 0 ? 'text-red-400' : ''}`}>{fmtValue(s.value)}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {(segments.length > 1 || (showCostOverlay && bar.cost !== null)) && (
                                      <div className="mt-1 pt-1 border-t border-white/10 space-y-0.5">
                                        {segments.length > 1 && (
                                          <div className="flex items-center justify-between gap-3">
                                            <span className="uppercase tracking-wider text-[9px] text-zinc-500">Total</span>
                                            <span className="font-semibold">{fmtValue(bar.total)}</span>
                                          </div>
                                        )}
                                        {showCostOverlay && bar.cost !== null && (
                                          <div className="flex items-center justify-between gap-3">
                                            <span className="uppercase tracking-wider text-[9px] text-zinc-500">Model cost</span>
                                            <span className="font-semibold text-amber-400">{fmtCurrency(bar.cost)}</span>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* X labels */}
                <div className="mt-2" style={{ marginLeft: 44 }}>
                  <div ref={labelsScrollRef} className="overflow-x-hidden sm:overflow-visible no-scrollbar">
                    <div
                      className="chart-scroll-content flex gap-[3px]"
                      style={{ '--bar-count': chart.bars.length } as React.CSSProperties}
                    >
                      {chart.bars.map((bar, i) => {
                        const total = chart.bars.length;
                        const step = Math.max(1, Math.floor(total / 6));
                        const show = i === 0 || i === total - 1 || i % step === 0;
                        return (
                          <div key={`lbl-${bar.startKey}`} className="flex-1 text-center">
                            <span className="text-[9px] lg:text-[10px] text-zinc-500 font-medium truncate block">
                              {show ? bar.label : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Legend: agent hues plus the cost overlay when shown */}
            {chartAgents.length > 0 && (
              <div className="flex items-center gap-3 mt-3 pt-3 border-t border-white/[0.06] flex-wrap">
                {chartAgents.map(m => {
                  const series = seriesByAgent.get(m.id) ?? AGENT_SERIES[0];
                  return (
                    <span key={m.id} className="flex items-center gap-1.5 px-2 py-1 rounded-md">
                      <span className={`w-2.5 h-2.5 rounded-sm ${series.dot}`} aria-hidden="true" />
                      <span className="text-[11px] text-zinc-300 font-medium">{m.name}</span>
                    </span>
                  );
                })}
                {showCostOverlay && (
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded-md">
                    <span className="w-3.5 h-[2px] rounded-full bg-amber-400" aria-hidden="true" />
                    <span className="text-[11px] text-zinc-300 font-medium">Model cost</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Leaderboard ────────────────────────────────────── */}
        <div className="glass-card rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 flex items-center justify-between border-b border-white/[0.06] flex-shrink-0">
            <div className="flex items-center gap-2">
              <Trophy size={18} className="text-zinc-400" aria-hidden="true" />
              <h2 className="font-semibold text-white">Leaderboard</h2>
            </div>
            <span className="text-xs text-zinc-500 font-medium hidden sm:inline">
              {focusedAgent ? 'Select the row again to see everyone' : 'Select a row to focus one agent'}
            </span>
          </div>

          {analytics.agents.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
              <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
                <Bot size={18} className="text-zinc-500" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-zinc-400">No agents in this selection</p>
              <p className="text-xs text-zinc-500 mt-1">Clear the agent filter, or add agent team members.</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <div className="grid grid-cols-[1fr_repeat(8,auto)] gap-x-5 px-5 py-2.5 text-[10px] uppercase tracking-wider font-medium text-zinc-500 border-b border-white/[0.06]">
                  <span>Agent</span>
                  <span className="text-right w-16">Opened</span>
                  <span className="text-right w-16">Merged</span>
                  <span className="text-right w-16">Rounds</span>
                  <span className="text-right w-20">Runtime</span>
                  <span className="text-right w-24">Lines +/-</span>
                  <span className="text-right w-20">Revenue</span>
                  <span className="text-right w-20">Cost</span>
                  <span className="text-right w-20">Profit</span>
                </div>
                <div className="divide-y divide-white/[0.06]">
                  {analytics.agents.map(row => {
                    const focused = focusedAgent?.id === row.agentId;
                    const member = roster.find(m => m.id === row.agentId);
                    return (
                      <div
                        key={row.agentId}
                        role="button"
                        tabIndex={0}
                        aria-pressed={focused}
                        onClick={() => toggleFocus(row.agentId)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFocus(row.agentId); }
                        }}
                        className={`grid grid-cols-[1fr_repeat(8,auto)] gap-x-5 px-5 py-3.5 items-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                          focused ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={row.agentName} src={member?.avatar || undefined} size="sm" />
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-white truncate block">{row.agentName}</span>
                            {member?.title && <span className="text-[11px] text-zinc-500 truncate block">{member.title}</span>}
                            {row.inputTokens.tracking === 'tracked' && (
                              <span className="text-[11px] text-zinc-500 truncate block">
                                In {fmtCount(row.inputTokens.value ?? 0)} · Out {fmtCount(row.outputTokens.value ?? 0)} · Cached {fmtCount(row.cachedTokens.value ?? 0)}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-sm text-zinc-300 font-medium text-right w-16">
                          {telemetry.handoff ? row.prsOpened : <NotTracked className="text-[11px]" reason="No pull request hand-offs have been recorded yet." />}
                        </span>
                        <span className="text-sm text-zinc-300 font-medium text-right w-16">
                          {telemetry.merged ? row.prsMerged : <NotTracked className="text-[11px]" reason="Merge telemetry has not reported yet." />}
                        </span>
                        <span className="text-sm text-zinc-300 font-medium text-right w-16">{row.reviewRounds}</span>
                        <span className="text-sm font-medium text-right w-20">
                          {row.runtimeMs.tracking === 'tracked' && row.runtimeMs.value !== null
                            ? <span className="text-sky-300">{fmtDuration(row.runtimeMs.value)}</span>
                            : <NotTracked className="text-[11px]" reason={runtimeReason} />}
                        </span>
                        <span className="text-sm font-medium text-right w-24">
                          {telemetry.merged
                            ? <><span className="text-emerald-400">+{fmtCount(row.additions)}</span>{' '}<span className="text-rose-400">-{fmtCount(row.deletions)}</span></>
                            : <NotTracked className="text-[11px]" reason="Line counts arrive with merge telemetry, which has not reported yet." />}
                        </span>
                        <span className="text-sm text-emerald-400 font-semibold text-right w-20">{fmtCurrency(row.revenue)}</span>
                        <span className="text-sm font-medium text-right w-20">
                          {row.modelCost.tracking === 'tracked' && row.modelCost.value !== null
                            ? <span className="text-amber-400">{fmtCurrency(row.modelCost.value)}</span>
                            : <NotTracked className="text-[11px]" reason={usageReason} />}
                        </span>
                        <span className="text-sm font-semibold text-right w-20">
                          {row.profit.tracking === 'tracked' && row.profit.value !== null
                            ? <span className={row.profit.value >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtCurrency(row.profit.value)}</span>
                            : <NotTracked className="text-[11px]" reason={usageReason} />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-white/[0.06]">
                {analytics.agents.map(row => {
                  const focused = focusedAgent?.id === row.agentId;
                  const member = roster.find(m => m.id === row.agentId);
                  return (
                    <div
                      key={row.agentId}
                      role="button"
                      tabIndex={0}
                      aria-pressed={focused}
                      onClick={() => toggleFocus(row.agentId)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFocus(row.agentId); }
                      }}
                      className={`block p-4 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                        focused ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 mb-1">
                        <Avatar name={row.agentName} src={member?.avatar || undefined} size="sm" />
                        <span className="text-sm font-medium text-white truncate">{row.agentName}</span>
                        {member?.title && <span className="text-[11px] text-zinc-500 truncate">{member.title}</span>}
                      </div>
                      {row.inputTokens.tracking === 'tracked' && (
                        <p className="text-[11px] text-zinc-500 mb-3">
                          In {fmtCount(row.inputTokens.value ?? 0)} · Out {fmtCount(row.outputTokens.value ?? 0)} · Cached {fmtCount(row.cachedTokens.value ?? 0)}
                        </p>
                      )}
                      <div className={`grid grid-cols-3 gap-3 ${row.inputTokens.tracking === 'tracked' ? '' : 'mt-2'}`}>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Opened</p>
                          {/* div, not p: NotTracked's tooltip trigger is a div
                              and a div inside p is a hydration error */}
                          <div className="text-sm font-semibold text-white">
                            {telemetry.handoff ? row.prsOpened : <NotTracked className="text-xs" reason="No pull request hand-offs have been recorded yet." />}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Merged</p>
                          <div className="text-sm font-semibold text-white">
                            {telemetry.merged ? row.prsMerged : <NotTracked className="text-xs" reason="Merge telemetry has not reported yet." />}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Rounds</p>
                          <p className="text-sm font-semibold text-white">{row.reviewRounds}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Runtime</p>
                          <p className="text-sm font-semibold text-sky-300">
                            {row.runtimeMs.tracking === 'tracked' && row.runtimeMs.value !== null
                              ? fmtDuration(row.runtimeMs.value)
                              : <NotTracked className="text-xs" reason={runtimeReason} />}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Revenue</p>
                          <p className="text-sm font-semibold text-emerald-400">{fmtCurrency(row.revenue)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Cost</p>
                          <div className="text-sm font-semibold text-amber-400">
                            {row.modelCost.tracking === 'tracked' && row.modelCost.value !== null
                              ? fmtCurrency(row.modelCost.value)
                              : <NotTracked className="text-xs" reason={usageReason} />}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Profit</p>
                          <div className="text-sm font-semibold">
                            {row.profit.tracking === 'tracked' && row.profit.value !== null
                              ? <span className={row.profit.value >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtCurrency(row.profit.value)}</span>
                              : <NotTracked className="text-xs" reason={usageReason} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {summary.usagePartial && (
                <p className="px-5 py-2.5 text-[11px] text-zinc-500 border-t border-white/[0.06]">
                  Usage telemetry reported for {summary.usageAgents} of {summary.totalAgents} agents in this selection. Token and cost totals cover only the reporting agents.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
