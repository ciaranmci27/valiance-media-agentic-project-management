'use client';

import { useCallback, useMemo, useState, type SetStateAction } from 'react';
import {
  Activity, Ban, BarChart3, CircleCheck, Clock, Coins, Cpu, DollarSign, GitMerge, MessageCircleQuestion, RotateCcw,
  SlidersHorizontal, Timer, TrendingUp, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { useCustomAgentAnalyticsCards } from '@/lib/extensions/hooks';
import { useRead } from '@/lib/query-cache';
import { agentsListRead } from '@/lib/reads';
import { useRemembered } from '@/lib/use-remembered';
import { roleLabel } from '@/lib/agents-ui';
import { toDateKey } from '@/lib/finance/vesting';
import { toLocalDateKey } from '@/lib/date-utils';
import { formatMoney, formatNumber } from '@/lib/format';
import { appLocale, startOfWeek } from '@/lib/region';
import { DEFAULT_PRESET, PRESET_OPTIONS, resolveRange, type RangePreset } from '@/lib/agent-range';
import { NO_RUN_FILTERS } from '@/lib/agents-tab';
import { demoRunFeedPage } from '@/lib/demo-agents-home';
import { computePipelineLatency } from '@/lib/agent-analytics';
import { computeTelemetryAnalytics } from '@/lib/agent-telemetry-analytics';
import { useAgentAnalyticsEvents, useTaskReopens } from '@/lib/use-agent-analytics-events';
import { useAnalyticsReads } from '@/lib/agent-analytics-reads';
import {
  METRIC_FORMAT, MIXED_LABEL, SUBSCRIPTION_LABEL, analyticsRunRows, arrangeTiles, buildAgentAnalytics, changeMetrics, costLabel, dailyByAgent, groupOf,
  marginOf, median, metricValue, periodChange, previousRange, profitCaveat, rangeDays, resolveSelectedMetric, runOutcomeLine, runRowFromFeed,
  runsListHref, scopeNotes, UNPRICED_LABEL, type BreakdownLabels, type Dimension, type MetricKey,
} from '@/lib/agent-analytics-model';
import { StatStrip } from '@/components/ui/StatStrip';
import { Button } from '@/components/ui/Button';
import { CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card, CardSkeleton, fmtCount, fmtDuration, fmtPct } from '@/components/agent/analytics/shared';
import { AnalyticsFilters } from '@/components/agent/analytics/AnalyticsFilters';
import { AnalyticsChart, formatMetric, type ChartPoint } from '@/components/agent/analytics/AnalyticsChart';
import { AnalyticsBreakdown } from '@/components/agent/analytics/AnalyticsBreakdown';
import { QualityCard } from '@/components/agent/analytics/QualityCard';
import { profileTimeZone } from '@/lib/time-zone';

/**
 * The Agents page's Analytics tab: how the agents work, at a glance. One
 * Overview card: its header holds the filters (agents and projects, date
 * range) and its actions; a stat strip of the figures with data, each with
 * change against the last period where that can be measured, picks the one
 * brand line charted below it (DESIGN.md Rules 16 and 17). Then a breakdown
 * by agent, project, model, role and label, and delivery quality. Work
 * leads; money shows only where agents bill. Every number comes from
 * agent-analytics-model, and Runs counts what Agents > Runs lists.
 *
 * An install adds its own cards below the breakdown through
 * agentAnalyticsCards (src/custom/index.ts); core renders none of its own
 * fleet-specific ones.
 */

/** Each stat's name in plain words, its icon, and the unit a count's chart axis shows. */
const TILE_META: Record<MetricKey, { label: string; icon: LucideIcon; unit: string }> = {
  revenue: { label: 'Revenue', icon: DollarSign, unit: '' },
  profit: { label: 'Profit', icon: TrendingUp, unit: '' },
  runs: { label: 'Runs', icon: Activity, unit: 'runs' },
  busy: { label: 'Time working', icon: Timer, unit: '' },
  tasks: { label: 'Tasks done', icon: CircleCheck, unit: 'tasks' },
  prs: { label: 'PRs merged', icon: GitMerge, unit: 'PRs' },
  tokens: { label: 'AI usage', icon: Cpu, unit: '' },
  cost: { label: 'AI cost', icon: Coins, unit: '' },
  questions: { label: 'Questions asked', icon: MessageCircleQuestion, unit: 'questions' },
  incidents: { label: 'Incidents', icon: TriangleAlert, unit: 'incidents' },
  reopened: { label: 'Reopened', icon: RotateCcw, unit: 'tasks' },
  blocked: { label: 'Blocked', icon: Ban, unit: 'times' },
};

const NO_FLEET: never[] = [];

type Granularity = 'day' | 'week' | 'month';

function bucketOf(dateKey: string, gran: Granularity): string {
  if (gran === 'day') return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  if (gran === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  return toDateKey(startOfWeek(new Date(y, m - 1, d)));
}

function dayLabel(key: string, gran: Granularity, todayKey: string, long = false): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const thisYear = y === new Date().getFullYear();
  if (gran === 'month') return date.toLocaleDateString(appLocale(), { month: long ? 'long' : 'short', year: thisYear ? undefined : 'numeric' });
  if (!long && gran === 'day' && key === todayKey) return 'Today';
  const text = date.toLocaleDateString(appLocale(), { weekday: long && gran === 'day' ? 'short' : undefined, month: 'short', day: 'numeric', year: long && !thisYear ? 'numeric' : undefined });
  return long && gran === 'week' ? `Week of ${text}` : text;
}

/** The report's remembered view in this browser: its range and its project and agent filters. */
interface AnalyticsPrefs {
  preset: RangePreset;
  customStart: string;
  customEnd: string;
  projects: string[];
  agents: string[];
}

const NO_PREFS: AnalyticsPrefs = { preset: DEFAULT_PRESET, customStart: '', customEnd: '', projects: [], agents: [] };
const PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', 'mtd', 'all', 'custom'];
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isAnalyticsPrefs = (v: unknown): v is AnalyticsPrefs => {
  const p = v as AnalyticsPrefs | null;
  return !!p && typeof p === 'object' && PRESETS.includes(p.preset) && typeof p.customStart === 'string' && typeof p.customEnd === 'string'
    && isStrings(p.projects) && isStrings(p.agents);
};

export function AgentAnalytics() {
  const { agentActivity: recentActivity, timeEntries, team, projects, tasks, taskSuggestions } = useApp();
  const { isDemoMode } = useDemo();
  const { access, teamMemberId } = useAuth();
  const me = team.find((m) => m.id === teamMemberId);
  const timezone = profileTimeZone(me);

  // A static "now" per mount: analytics is a report, not a live ticker.
  const [now] = useState(() => Date.now());
  const todayKey = toLocalDateKey(new Date(now).toISOString(), timezone);

  // The range and filters come back on the next visit (this browser only).
  const [prefs, setPrefs] = useRemembered<AnalyticsPrefs>('pm:agent-analytics', NO_PREFS, isAnalyticsPrefs);
  const { preset, customStart, customEnd } = prefs;
  const selectedProjectIds = useMemo(() => new Set(prefs.projects), [prefs.projects]);
  const selectedAgentIds = useMemo(() => new Set(prefs.agents), [prefs.agents]);
  const setPreset = useCallback((next: RangePreset) => setPrefs((p) => ({ ...p, preset: next })), [setPrefs]);
  const setCustomStart = useCallback((next: string) => setPrefs((p) => ({ ...p, customStart: next })), [setPrefs]);
  const setCustomEnd = useCallback((next: string) => setPrefs((p) => ({ ...p, customEnd: next })), [setPrefs]);
  const setSelectedProjectIds = useCallback((next: SetStateAction<Set<string>>) => setPrefs((p) => {
    const resolved = typeof next === 'function' ? next(new Set(p.projects)) : next;
    return { ...p, projects: [...resolved] };
  }), [setPrefs]);
  const setSelectedAgentIds = useCallback((next: SetStateAction<Set<string>>) => setPrefs((p) => {
    const resolved = typeof next === 'function' ? next(new Set(p.agents)) : next;
    return { ...p, agents: [...resolved] };
  }), [setPrefs]);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<MetricKey | null>(null);
  const [expanded, setExpanded] = useState(false);

  const roster = useMemo(() => team.filter((m) => m.role === 'agent').sort((a, b) => a.name.localeCompare(b.name)), [team]);
  const agentList = useRead(agentsListRead(isDemoMode)).data;
  const roleById = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a.agent_role ? roleLabel(a.agent_role) : null])), [agentList]);

  const earliestDateKey = useMemo(() => {
    let earliest: string | null = null;
    for (const a of recentActivity) {
      const k = toLocalDateKey(a.created_at, timezone);
      if (!earliest || k < earliest) earliest = k;
    }
    return earliest;
  }, [recentActivity, timezone]);
  const range = useMemo(() => resolveRange(preset, customStart, customEnd, earliestDateKey, todayKey),
    [preset, customStart, customEnd, earliestDateKey, todayKey]);

  // ── Reads ─────────────────────────────────────────────────
  const events = useAgentAnalyticsEvents(range, { enabled: !isDemoMode });
  const projectFilterIds = useMemo(() => [...selectedProjectIds], [selectedProjectIds]);
  const reads = useAnalyticsReads(range, { enabled: !isDemoMode, timezone, projectIds: projectFilterIds });
  const reopenQuery = useTaskReopens({ enabled: !isDemoMode });
  const activities = isDemoMode ? recentActivity : events.rows;
  const measuring = events.loading || reads.loading;
  // The run feed is the runs, so Runs here is what Agents > Runs lists: the
  // database's feed, or the demo's own. Only where no feed exists (not
  // migrated) are runs taken from turns, by its own rule. A failed read shows
  // no run figures at all rather than short ones.
  const runsAvailable = !reads.runsFailed;
  const demoFeed = useMemo(() => (isDemoMode ? demoRunFeedPage(NO_RUN_FILTERS, null, 10_000).runs.map(runRowFromFeed) : null), [isDemoMode]);
  const runs = useMemo(() => analyticsRunRows({
    runsFailed: reads.runsFailed,
    serverSummed: !!reads.runStats,
    feedRows: demoFeed ?? (reads.runs && !reads.runs.unavailable ? reads.runs.rows : null),
    activities,
  }), [reads.runsFailed, reads.runStats, reads.runs, demoFeed, activities]);
  const truncated = events.truncated || !!reads.runs?.truncated || !!reads.questions?.truncated;

  const billingModuleOn = isModuleEnabled(access, 'billing');
  // The server's canReadRevenueInputs, mirrored: revenue needs billing.manage or finance.company.read.
  const canReadRevenue = hasPermission(access, 'billing.manage') || hasPermission(access, 'finance.company.read');
  const scope = scopeNotes({
    projectsReadAll: hasPermission(access, 'projects.read_all'),
    timeReadAll: hasPermission(access, 'time.read_all'),
    questionsScope: reads.questionStats?.scope ?? null,
  });
  const agents = useMemo(() => roster.map((m) => ({ id: m.id, name: m.name, role: roleById.get(m.id) ?? null })), [roster, roleById]);

  const model = useMemo(() => buildAgentAnalytics({
    range, timezone, now, agents, projects, runs, activities,
    questions: reads.questions?.rows ?? [],
    runStats: reads.runStats,
    questionStats: reads.questionStats,
    providerPlans: reads.providerPlans,
    tasks,
    reopens: isDemoMode ? [] : (reopenQuery.rows ?? []).map((r) => ({ taskId: r.task_id, projectId: r.project_id, reopenedAt: r.reopened_at })),
    timeEntries,
    billingModuleOn,
    canReadRevenue,
    runsAvailable,
    selectedAgentIds,
    selectedProjectIds,
    selectedLabels,
  }), [range, timezone, now, agents, projects, runs, activities, reads.questions, reads.runStats, reads.questionStats, reads.providerPlans, tasks, isDemoMode, reopenQuery.rows, timeEntries, billingModuleOn, canReadRevenue, runsAvailable, selectedAgentIds, selectedProjectIds, selectedLabels]);
  // The last period, for change: only what the server sums (or the demo's
  // feed) measures as fully as this range; the event window does not reach back.
  const lastRange = useMemo(() => previousRange(range), [range]);
  const compare = preset !== 'all';
  const lastReads = useAnalyticsReads(lastRange, { enabled: !isDemoMode && compare, timezone, projectIds: projectFilterIds });
  const comparable = useMemo(() => (compare ? changeMetrics({
    runStats: !!reads.runStats && !!lastReads.runStats,
    spend: !!reads.runStats?.spend && !!lastReads.runStats?.spend,
    questionStats: !!reads.questionStats && !!lastReads.questionStats,
    feedRows: !!demoFeed,
  }) : []), [compare, reads.runStats, lastReads.runStats, reads.questionStats, lastReads.questionStats, demoFeed]);
  const lastModel = useMemo(() => (comparable.length === 0 ? null : buildAgentAnalytics({
    range: lastRange, timezone, now, agents, projects,
    runs: demoFeed ?? [],
    activities: [],
    questions: [],
    runStats: lastReads.runStats,
    questionStats: lastReads.questionStats,
    tasks: [],
    reopens: [],
    timeEntries: [],
    billingModuleOn,
    canReadRevenue,
    runsAvailable,
    selectedAgentIds,
    selectedProjectIds,
    selectedLabels,
  })), [comparable.length, lastRange, timezone, now, agents, projects, demoFeed, lastReads.runStats, lastReads.questionStats, billingModuleOn, canReadRevenue, runsAvailable, selectedAgentIds, selectedProjectIds, selectedLabels]);
  const caveat = profitCaveat(model.excludedNoProject, formatMoney);
  // Project rows exclude usage with no project too: under a filter it was
  // dropped; unfiltered it sits on the No project row.
  const projectRowsCaveat = useMemo(() => (selectedProjectIds.size > 0
    ? caveat
    : profitCaveat(groupOf(model.facts.filter((f) => f.projectId === null)).sums, formatMoney)), [selectedProjectIds, caveat, model.facts]);
  const customCards = useCustomAgentAnalyticsCards();

  const s = model.totals.sums;
  const arranged = arrangeTiles(model.tiles, { expanded });
  const withData = model.tiles.filter((t) => t.hasData).map((t) => t.key);
  const selected = resolveSelectedMetric(arranged.shown, picked, withData);
  const days = useMemo(() => rangeDays(range), [range]);

  // ── Tiles ─────────────────────────────────────────────────
  // A provider plan's cost: an estimate, said as one, never inside model cost.
  const subscriptionLine = model.subscription
    ? `${SUBSCRIPTION_LABEL} ${formatMoney(model.subscription.monthlyUsd)}/month, about ${formatMoney(model.subscription.estimateUsd)} here (estimate)`
    : null;
  // Money and counts stay plain ink (Rule 16): color is only for change with a meaning.
  const tileView = (key: MetricKey): { value: string | null; empty?: string; context?: string } => {
    const cost = costLabel(s);
    switch (key) {
      case 'revenue': return {
        value: formatMoney(s.revenue),
        context: [
          `${formatNumber(s.billableHours, { maximumFractionDigits: 1 })} hrs approved`,
          s.pendingRevenue > 0.005 ? `${formatMoney(s.pendingRevenue)} pending` : null,
          scope.revenue,
        ].filter(Boolean).join(' · '),
      };
      case 'profit': {
        const profit = s.revenue - s.costUsd;
        const margin = marginOf(s);
        const unpriced = cost.kind === 'partial' || cost.kind === 'unpriced';
        return {
          value: formatMoney(profit),
          context: [
            margin !== null ? `${fmtPct(margin)} margin` : 'Revenue minus model cost',
            caveat,
            unpriced ? 'unpriced usage not in cost' : null,
          ].filter(Boolean).join(' · '),
        };
      }
      case 'runs': return { value: formatNumber(s.run), context: runOutcomeLine(s) };
      case 'busy': return { value: s.busyMs > 0 ? fmtDuration(s.busyMs) : '0', context: 'Time spent on runs, overlaps counted once' };
      case 'tasks': return { value: formatNumber(s.taskDone), context: scope.tasks ?? 'Completed by agents' };
      case 'prs': return {
        value: formatNumber(s.prMerged),
        context: [`${formatNumber(s.prOpened)} opened`, `${formatNumber(s.review)} reviews`].join(' · '),
      };
      case 'tokens': return {
        value: fmtCount(s.tokensIn + s.tokensOut),
        context: [
          `tokens: ${fmtCount(s.tokensIn)} sent, ${fmtCount(s.tokensOut)} back${s.tokensCached > 0 ? `, ${fmtCount(s.tokensCached)} cached` : ''}`,
          s.runsNoTokens > 0 ? `Runs that report no tokens: ${formatNumber(s.runsNoTokens)}` : null,
        ].filter(Boolean).join(' · '),
      };
      case 'cost': {
        const withPlan = (context: string) => [context, subscriptionLine].filter(Boolean).join(' · ');
        if (cost.kind === 'unpriced') return { value: null, empty: 'Unpriced', context: withPlan(UNPRICED_LABEL) };
        if (cost.kind === 'none') return { value: null, empty: 'None', context: withPlan('No usage in range') };
        return {
          value: formatMoney(cost.usd),
          context: withPlan(cost.kind === 'partial' ? 'Plus unpriced usage' : cost.kind === 'mixed' ? `Hourly sums, ${MIXED_LABEL}` : 'Priced by the provider'),
        };
      }
      case 'questions': {
        const answer = median(model.totals.samples.answerMs);
        return {
          value: formatNumber(s.question + s.approval),
          context: [
            s.approval > 0 ? `${formatNumber(s.approval)} ${s.approval === 1 ? 'approval' : 'approvals'}` : null,
            answer !== null ? `answered in ${fmtDuration(answer)}` : null,
            scope.questions,
          ].filter(Boolean).join(' · '),
        };
      }
      case 'incidents': return { value: formatNumber(s.incident), context: 'Repeats counted once' };
      case 'reopened': return {
        value: formatNumber(s.reopen),
        context: s.taskDone > 0 ? `${fmtPct(s.reopen / s.taskDone)} of tasks done` : 'Tasks moved out of done',
      };
      case 'blocked': {
        const resume = median(model.totals.samples.resumeMs);
        return { value: formatNumber(s.blocked), context: resume !== null ? `resumed in ${fmtDuration(resume)}` : 'Repeats counted once' };
      }
    }
  };

  const sparks = useMemo(() => {
    const out = new Map<MetricKey, number[]>();
    for (const key of arranged.shown) out.set(key, dailyByAgent(model.facts, key, days).map((d) => d.total));
    return out;
  }, [arranged.shown, model.facts, days]);

  // ── Chart: the picked stat as one brand line, per day, week or month ──
  const gran: Granularity = days.length <= 90 ? 'day' : days.length <= 365 ? 'week' : 'month';
  const points = useMemo<ChartPoint[]>(() => {
    if (!selected) return [];
    const order: string[] = [];
    const buckets = new Map<string, ChartPoint>();
    for (const point of dailyByAgent(model.facts, selected, days)) {
      const key = bucketOf(point.dateKey, gran);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { label: dayLabel(key, gran, todayKey), title: dayLabel(key, gran, todayKey, true), value: 0 };
        buckets.set(key, bucket);
        order.push(key);
      }
      bucket.value += point.total;
    }
    return order.map((k) => buckets.get(k)!);
  }, [selected, days, gran, model.facts, todayKey]);
  const rangeWords = preset === 'custom' || preset === 'all'
    ? `${dayLabel(range.startKey, 'day', '', true)} to ${dayLabel(range.endKey, 'day', '', true)}`
    : (PRESET_OPTIONS.find((o) => o.value === preset)?.label ?? '').toLowerCase();
  const chartTitle = selected ? `${TILE_META[selected].label} per ${gran}, ${rangeWords}` : '';
  const chartEmpty = selected === 'cost' && costLabel(s).kind === 'unpriced'
    ? 'The provider sent no price for this usage (often a subscription). Pick AI usage to see it.'
    : `${selected ? TILE_META[selected].label : 'Figures'} for each ${gran} show here once your agents have some in this range`;

  // ── Breakdown ─────────────────────────────────────────────
  const labels = useMemo<BreakdownLabels>(() => ({
    agentName: (id) => roster.find((m) => m.id === id)?.name ?? 'Unknown agent',
    projectName: (id) => projects.find((p) => p.id === id)?.name ?? 'Unknown project',
    roleOf: (id) => roleById.get(id) ?? null,
  }), [roster, projects, roleById]);
  const entity = (dimension: Dimension, key: string) => (dimension === 'agent'
    ? { avatar: roster.find((m) => m.id === key)?.avatar ?? null }
    : dimension === 'project' ? { color: projects.find((p) => p.id === key)?.color ?? null } : {});
  const focusedAgentId = selectedAgentIds.size === 1 ? [...selectedAgentIds][0] : null;
  const toggleFocus = (agentId: string) => setSelectedAgentIds((prev) => (prev.size === 1 && prev.has(agentId) ? new Set() : new Set([agentId])));
  const focusedLabel = selectedLabels.size === 1 ? [...selectedLabels][0] : null;
  const toggleLabel = (label: string) => setSelectedLabels((prev) => (prev.size === 1 && prev.has(label) ? new Set() : new Set([label])));

  // ── Delivery quality: only when there is review and merge work to read ──
  const hasDelivery = s.prOpened + s.prMerged + s.review > 0;
  const latency = useMemo(() => (hasDelivery ? computePipelineLatency(activities, range, timezone) : []), [hasDelivery, activities, range, timezone]);
  const quality = useMemo(() => (hasDelivery ? computeTelemetryAnalytics({
    activities,
    team,
    range,
    now,
    timezone,
    selectedAgentIds: selectedAgentIds.size ? selectedAgentIds : undefined,
    selectedProjectIds: selectedProjectIds.size ? selectedProjectIds : undefined,
    suggestions: taskSuggestions,
    reopens: isDemoMode ? null : reopenQuery.rows,
    reopenTrackingSince: reopenQuery.since,
  }).quality : null), [hasDelivery, activities, team, range, now, timezone, selectedAgentIds, selectedProjectIds, taskSuggestions, isDemoMode, reopenQuery.rows, reopenQuery.since]);

  const filterProjects = useMemo(() => projects.filter((p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name, color: p.color })), [projects]);
  const filterAgents = useMemo(() => roster.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null })), [roster]);
  const filtered = selectedAgentIds.size > 0 || selectedProjectIds.size > 0 || selectedLabels.size > 0;
  // The same runs in Agents > Runs, when it can list exactly this selection.
  const runsHref = useMemo(() => runsListHref(range, { agentIds: selectedAgentIds, projectIds: selectedProjectIds, labels: selectedLabels }),
    [range, selectedAgentIds, selectedProjectIds, selectedLabels]);
  const clearFilters = () => { setSelectedAgentIds(new Set()); setSelectedProjectIds(new Set()); setSelectedLabels(new Set()); };
  const changeOf = (key: MetricKey) => {
    if (!lastModel || !comparable.includes(key)) return undefined;
    const change = periodChange(key, metricValue(key, s), metricValue(key, lastModel.totals.sums));
    return change ? { ...change, against: undefined } : undefined;
  };
  const noData = !measuring && arranged.shown.length === 0;
  const notes = [
    focusedLabel && (
      <div key="label" role="status" className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
        <p>Only what came from events labelled <span className="font-mono text-zinc-200">{focusedLabel}</span>. Runs, tasks, questions and time carry no labels, so they leave while a label is picked.</p>
        <Button variant="ghost" size="sm" onClick={() => setSelectedLabels(new Set())}>Show everything</Button>
      </div>
    ),
    !measuring && truncated && (
      <p key="cut" role="status" className="text-xs text-amber-300">
        This range holds more agent records than one read can take, so figures under-report. Narrow the date range for complete numbers.
      </p>
    ),
    !measuring && (events.failed || reads.runsFailed || reads.questionsFailed) && (
      <div key="failed" role="status" className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-red-300">
          {reads.runsFailed
            ? 'Runs could not be read, so runs, time working, AI usage, cost and incidents are left out.'
            : 'Part of this report could not be read, so some figures are missing.'}
        </p>
        <Button variant="secondary" size="sm" onClick={reads.reload}>Try again</Button>
      </div>
    ),
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-card rounded-xl" aria-labelledby="analytics-overview">
        <CardHeader
          id="analytics-overview"
          icon={<BarChart3 />}
          title="Overview"
          action={(
            <>
              {runsAvailable && runsHref && s.run > 0 && !measuring && (
                <Button variant="ghost" size="sm" href={runsHref}>See these runs</Button>
              )}
              {!measuring && (arranged.more > 0 || expanded) && (
                <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={14} aria-hidden="true" />} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Fewer stats' : `More stats (${arranged.more})`}
                </Button>
              )}
              <AnalyticsFilters
                preset={preset} onPreset={setPreset}
                customStart={customStart} customEnd={customEnd} onCustomStart={setCustomStart} onCustomEnd={setCustomEnd}
                earliestDateKey={earliestDateKey} todayKey={todayKey}
                projects={filterProjects} selectedProjectIds={selectedProjectIds} onProjects={setSelectedProjectIds}
                agents={filterAgents} selectedAgentIds={selectedAgentIds} onAgents={setSelectedAgentIds}
              />
            </>
          )}
        />
        <div className="flex min-w-0 flex-col gap-4 px-4 pb-4 lg:px-5 lg:pb-5">
          {notes}
          {noData ? (
            filtered ? (
              <EmptyState variant="filtered" title="No agent work for these filters"
                description="Try a wider date range, or clear the agent and project filters." onClearFilters={clearFilters} />
            ) : (
              <EmptyState title="No agent work in this range"
                description="Runs, tasks done and AI usage show here once your agents work. Try a wider date range." />
            )
          ) : (
            <>
              <StatStrip
                bare
                label="Headline numbers. Pick one to chart it."
                loading={measuring}
                stats={(measuring ? model.tiles.slice(0, 6).map((t) => t.key) : arranged.shown).map((key) => {
                  const view = tileView(key);
                  const spark = sparks.get(key);
                  return {
                    id: key,
                    label: TILE_META[key].label,
                    icon: TILE_META[key].icon,
                    value: view.value,
                    empty: view.empty,
                    context: view.context,
                    change: changeOf(key),
                    spark: view.value !== null && spark?.some((v) => v !== 0) ? spark : undefined,
                    selected: selected === key,
                    onSelect: () => setPicked(key),
                  };
                })}
              />
              {(measuring || selected) && (
                <AnalyticsChart
                  title={measuring ? 'Loading' : chartTitle}
                  note={selected === 'profit' ? caveat : null}
                  points={points}
                  format={selected ? METRIC_FORMAT[selected] : 'count'}
                  unit={selected ? TILE_META[selected].unit : ''}
                  loading={measuring}
                  empty={chartEmpty}
                />
              )}
            </>
          )}
        </div>
      </section>

      <AnalyticsBreakdown
        facts={model.facts}
        totals={model.totals}
        metric={selected}
        metricLabel={selected ? TILE_META[selected].label : null}
        showMoney={model.money.show}
        projectCaveat={projectRowsCaveat}
        labels={labels}
        entity={entity}
        loading={measuring}
        focusedAgentId={focusedAgentId}
        onFocusAgent={toggleFocus}
        focusedLabel={focusedLabel}
        onFocusLabel={toggleLabel}
        subscriptionLine={subscriptionLine}
      />

      {customCards.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {customCards.map(({ key, title, size, component: Body }) => (
            <div key={key} aria-label={title} role="region" className={`${size === 'half' ? '' : 'lg:col-span-2'} min-w-0`}>
              <Body
                range={range}
                timezone={timezone}
                now={now}
                selectedAgentIds={selectedAgentIds}
                selectedProjectIds={selectedProjectIds}
                model={model}
                activities={activities}
                fleetActivities={isDemoMode ? NO_FLEET : events.fleet}
                attribution={isDemoMode ? undefined : events.attribution}
                measuring={measuring}
              />
            </div>
          ))}
        </div>
      )}

      {!measuring && hasDelivery && quality && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" role="region" aria-label="Delivery quality">
            <QualityCard quality={quality} measuring={reopenQuery.loading} />
            <Card icon={Clock} title="Where work waits">
              {latency.length === 0 ? <CardSkeleton rows={3} /> : (
                <div className="divide-y divide-white/[0.06]">
                  {latency.map((stage) => (
                    <div key={stage.key} className="px-4 lg:px-5 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-300 truncate">{stage.label}</p>
                        <p className="text-[11px] text-zinc-500">
                          {stage.samples > 0 ? `${stage.samples} handoff${stage.samples === 1 ? '' : 's'}` : 'none in range'}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        {stage.notTracked ? (
                          <span className="text-xs text-zinc-500">Not tracked</span>
                        ) : stage.medianMs === null ? (
                          <span className="text-sm text-zinc-500">None</span>
                        ) : (
                          <>
                            <p className="text-sm font-semibold text-white tabular-nums">{formatMetric(stage.medianMs, 'duration')}</p>
                            <p className="text-[11px] text-zinc-500">worst {fmtDuration(stage.worstMs ?? 0)}</p>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
        </div>
      )}
    </div>
  );
}
