'use client';

import { useCallback, useMemo, useState, type SetStateAction } from 'react';
import Link from 'next/link';
import {
  Activity, Ban, CircleCheck, Clock, Coins, Cpu, DollarSign, GitMerge, MessageCircleQuestion, RotateCcw,
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
import { DEFAULT_PRESET, resolveRange, type RangePreset } from '@/lib/agent-range';
import { computePipelineLatency } from '@/lib/agent-analytics';
import { computeTelemetryAnalytics } from '@/lib/agent-telemetry-analytics';
import { useAgentAnalyticsEvents, useTaskReopens } from '@/lib/use-agent-analytics-events';
import { useAnalyticsReads } from '@/lib/agent-analytics-reads';
import {
  METRIC_FORMAT, MIXED_LABEL, SUBSCRIPTION_LABEL, arrangeTiles, buildAgentAnalytics, costLabel, dailyByAgent, groupOf, marginOf, median, profitCaveat,
  rangeDays, resolveSelectedMetric, runOutcomeLine, runsFromTurns, scopeNotes, topAgents, UNPRICED_LABEL,
  type BreakdownLabels, type Dimension, type MetricKey,
} from '@/lib/agent-analytics-model';
import { StatStrip, type StatTone } from '@/components/ui/StatStrip';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardSkeleton, fmtCount, fmtDuration, fmtPct } from '@/components/agent/analytics/shared';
import { AnalyticsFilters } from '@/components/agent/analytics/AnalyticsFilters';
import { AnalyticsChart, formatMetric, type ChartBar, type ChartSeries } from '@/components/agent/analytics/AnalyticsChart';
import { AnalyticsBreakdown } from '@/components/agent/analytics/AnalyticsBreakdown';
import { QualityCard } from '@/components/agent/analytics/QualityCard';
import { profileTimeZone } from '@/lib/time-zone';

/**
 * The Agents page's Analytics tab: how the agents work, at a glance. Tiles
 * with data lead (the picked one drives the chart), a breakdown by agent,
 * project, model, role and label, then delivery quality. Money shows only
 * where agents bill. Every number comes from agent-analytics-model; runs and
 * questions arrive summed by the server, so no range is cut short.
 *
 * An install adds its own cards below the breakdown through
 * agentAnalyticsCards (src/custom/index.ts); core renders none of its own
 * fleet-specific ones.
 */

const TILE_META: Record<MetricKey, { label: string; icon: LucideIcon }> = {
  revenue: { label: 'Revenue', icon: DollarSign },
  profit: { label: 'Profit', icon: TrendingUp },
  runs: { label: 'Runs', icon: Activity },
  busy: { label: 'Busy time', icon: Timer },
  tasks: { label: 'Tasks done', icon: CircleCheck },
  prs: { label: 'PRs merged', icon: GitMerge },
  tokens: { label: 'Tokens', icon: Cpu },
  cost: { label: 'Model cost', icon: Coins },
  questions: { label: 'Questions asked', icon: MessageCircleQuestion },
  incidents: { label: 'Incidents', icon: TriangleAlert },
  reopened: { label: 'Reopened', icon: RotateCcw },
  blocked: { label: 'Blocked', icon: Ban },
};

// One hue per charted agent, from the vivid chart family; the rest share a gray.
const SERIES = [
  { bar: 'bg-sky-400', dot: 'bg-sky-400' },
  { bar: 'bg-violet-500', dot: 'bg-violet-500' },
  { bar: 'bg-amber-400', dot: 'bg-amber-400' },
  { bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  { bar: 'bg-rose-400', dot: 'bg-rose-400' },
  { bar: 'bg-teal-500', dot: 'bg-teal-500' },
];
const OTHERS = { id: '__others', name: 'Other agents', bar: 'bg-zinc-500', dot: 'bg-zinc-500' };

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
  // The run feed is the runs. Only where it does not exist (not migrated, or
  // demo) are runs taken from turns, by its own rule. A failed read shows no
  // run figures at all rather than short ones.
  const runsAvailable = !reads.runsFailed;
  const runs = useMemo(() => {
    if (reads.runsFailed || reads.runStats) return [];
    return reads.runs && !reads.runs.unavailable ? reads.runs.rows : runsFromTurns(activities);
  }, [reads.runsFailed, reads.runStats, reads.runs, activities]);
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
  const caveat = profitCaveat(model.excludedNoProject, formatMoney);
  // Project rows exclude usage with no project too: under a filter it was
  // dropped; unfiltered it sits on the No project row.
  const projectRowsCaveat = useMemo(() => (selectedProjectIds.size > 0
    ? caveat
    : profitCaveat(groupOf(model.facts.filter((f) => f.projectId === null)).sums, formatMoney)), [selectedProjectIds, caveat, model.facts]);
  const customCards = useCustomAgentAnalyticsCards();

  const s = model.totals.sums;
  const arranged = arrangeTiles(model.tiles, { expanded });
  const selected = resolveSelectedMetric(arranged.shown, picked);
  const days = useMemo(() => rangeDays(range), [range]);

  // ── Tiles ─────────────────────────────────────────────────
  // A provider plan's cost: an estimate, said as one, never inside model cost.
  const subscriptionLine = model.subscription
    ? `${SUBSCRIPTION_LABEL} ${formatMoney(model.subscription.monthlyUsd)}/month, about ${formatMoney(model.subscription.estimateUsd)} here (estimate)`
    : null;
  const tileView = (key: MetricKey): { value: string | null; empty?: string; context?: string; tone: StatTone } => {
    const cost = costLabel(s);
    switch (key) {
      case 'revenue': return {
        value: formatMoney(s.revenue), tone: 'success',
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
          value: formatMoney(profit), tone: profit < 0 ? 'danger' : 'success',
          context: [
            margin !== null ? `${fmtPct(margin)} margin` : 'Revenue minus model cost',
            caveat,
            unpriced ? 'unpriced usage not in cost' : null,
          ].filter(Boolean).join(' · '),
        };
      }
      case 'runs': return { value: formatNumber(s.run), tone: 'default', context: runOutcomeLine(s) };
      case 'busy': return { value: s.busyMs > 0 ? fmtDuration(s.busyMs) : '0', tone: 'info', context: 'Time on runs, overlaps once' };
      case 'tasks': return { value: formatNumber(s.taskDone), tone: 'default', context: scope.tasks ?? 'Completed by agents' };
      case 'prs': return {
        value: formatNumber(s.prMerged), tone: 'default',
        context: [`${formatNumber(s.prOpened)} opened`, `${formatNumber(s.review)} reviews`].join(' · '),
      };
      case 'tokens': return {
        value: fmtCount(s.tokensIn + s.tokensOut), tone: 'default',
        context: [
          `${fmtCount(s.tokensIn)} in · ${fmtCount(s.tokensOut)} out${s.tokensCached > 0 ? ` · ${fmtCount(s.tokensCached)} cached` : ''}`,
          s.runsNoTokens > 0 ? `Runs that report no tokens: ${formatNumber(s.runsNoTokens)}` : null,
        ].filter(Boolean).join(' · '),
      };
      case 'cost': {
        const withPlan = (context: string) => [context, subscriptionLine].filter(Boolean).join(' · ');
        if (cost.kind === 'unpriced') return { value: null, empty: 'Unpriced', tone: 'default', context: withPlan(UNPRICED_LABEL) };
        if (cost.kind === 'none') return { value: null, empty: 'None', tone: 'default', context: withPlan('No usage in range') };
        return {
          value: formatMoney(cost.usd), tone: 'warning',
          context: withPlan(cost.kind === 'partial' ? 'Plus unpriced usage' : cost.kind === 'mixed' ? `Hourly sums, ${MIXED_LABEL}` : 'Priced by the provider'),
        };
      }
      case 'questions': {
        const answer = median(model.totals.samples.answerMs);
        return {
          value: formatNumber(s.question + s.approval), tone: 'default',
          context: [
            s.approval > 0 ? `${formatNumber(s.approval)} approvals` : null,
            answer !== null ? `answered in ${fmtDuration(answer)}` : null,
            scope.questions,
          ].filter(Boolean).join(' · '),
        };
      }
      case 'incidents': return { value: formatNumber(s.incident), tone: s.incident > 0 ? 'danger' : 'default', context: 'Repeats counted once' };
      case 'reopened': return {
        value: formatNumber(s.reopen), tone: s.reopen > 0 ? 'warning' : 'default',
        context: s.taskDone > 0 ? `${fmtPct(s.reopen / s.taskDone)} of tasks done` : 'Tasks moved out of done',
      };
      case 'blocked': {
        const resume = median(model.totals.samples.resumeMs);
        return { value: formatNumber(s.blocked), tone: s.blocked > 0 ? 'warning' : 'default', context: resume !== null ? `resumed in ${fmtDuration(resume)}` : 'Repeats counted once' };
      }
    }
  };

  const sparks = useMemo(() => {
    const out = new Map<MetricKey, number[]>();
    for (const key of arranged.shown) out.set(key, dailyByAgent(model.facts, key, days).map((d) => d.total));
    return out;
  }, [arranged.shown, model.facts, days]);

  // ── Chart ─────────────────────────────────────────────────
  const chart = useMemo(() => {
    if (!selected) return null;
    const gran: Granularity = days.length <= 90 ? 'day' : days.length <= 365 ? 'week' : 'month';
    const top = topAgents(model.facts, selected, SERIES.length);
    const ids = new Set(top.ids);
    const nameOf = (id: string) => roster.find((m) => m.id === id)?.name ?? 'Unknown agent';
    const series: ChartSeries[] = top.ids.map((id, i) => ({ id, name: nameOf(id), ...SERIES[i] }));
    if (top.others) series.push(OTHERS);
    const order: string[] = [];
    const buckets = new Map<string, ChartBar>();
    for (const point of dailyByAgent(model.facts, selected, days)) {
      const key = bucketOf(point.dateKey, gran);
      let bar = buckets.get(key);
      if (!bar) {
        bar = { startKey: key, label: dayLabel(key, gran, todayKey), title: dayLabel(key, gran, todayKey, true), values: new Map() };
        buckets.set(key, bar);
        order.push(key);
      }
      for (const [agentId, value] of point.perAgent) {
        const id = ids.has(agentId) ? agentId : OTHERS.id;
        bar.values.set(id, (bar.values.get(id) ?? 0) + value);
      }
    }
    return { gran, series, bars: order.map((k) => buckets.get(k)!) };
  }, [selected, days, model.facts, roster, todayKey]);

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
  const runsHref = useMemo(() => {
    const params = new URLSearchParams({ tab: 'runs', from: range.startKey, to: range.endKey });
    if (selectedAgentIds.size === 1) params.set('agent', [...selectedAgentIds][0]);
    if (selectedProjectIds.size === 1) params.set('project', [...selectedProjectIds][0]);
    return `/agent?${params.toString()}`;
  }, [range.startKey, range.endKey, selectedAgentIds, selectedProjectIds]);

  return (
    <div className="space-y-4 lg:space-y-6">
      <AnalyticsFilters
        range={range} preset={preset} onPreset={setPreset}
        customStart={customStart} customEnd={customEnd} onCustomStart={setCustomStart} onCustomEnd={setCustomEnd}
        earliestDateKey={earliestDateKey} todayKey={todayKey}
        projects={filterProjects} selectedProjectIds={selectedProjectIds} onProjects={setSelectedProjectIds}
        agents={filterAgents} selectedAgentIds={selectedAgentIds} onAgents={setSelectedAgentIds}
      />

      {focusedLabel && (
        <div role="status" className="glass-card rounded-xl px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-300">
            Only what came from events labelled <span className="font-mono text-white">{focusedLabel}</span>. Runs, tasks, questions and time carry no labels, so they leave while a label is picked.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setSelectedLabels(new Set())}>Show everything</Button>
        </div>
      )}

      {!measuring && truncated && (
        <p role="status" className="glass-card rounded-xl px-5 py-3 text-xs text-amber-300">
          This range holds more agent records than one read can take, so figures under-report. Narrow the date range for complete numbers.
        </p>
      )}
      {!measuring && (events.failed || reads.runsFailed || reads.questionsFailed) && (
        <div role="status" className="glass-card rounded-xl px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-red-300">
            {reads.runsFailed
              ? 'Runs could not be read, so runs, busy time, tokens, cost and incidents are left out.'
              : 'Part of this report could not be read, so some figures are missing.'}
          </p>
          <Button variant="secondary" size="sm" onClick={reads.reload}>Try again</Button>
        </div>
      )}

      {/* ── Headline tiles: the ones with data; the picked one drives the chart ── */}
      {measuring || arranged.shown.length > 0 ? (
        <div className="space-y-2">
          <StatStrip
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
                tone: view.tone,
                spark: view.value !== null && spark?.some((v) => v !== 0) ? spark : undefined,
                selected: selected === key,
                onSelect: () => setPicked(key),
              };
            })}
          />
          {!measuring && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* The same runs in the Runs list: this range, and the one agent or project picked. */}
              {runsAvailable && s.run > 0 && (
                <Link href={runsHref} className="rounded px-2 py-1 text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  See these runs
                </Link>
              )}
              {(arranged.more > 0 || expanded) && (
                <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={14} aria-hidden="true" />} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Fewer stats' : `More stats (${arranged.more})`}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="glass-card rounded-xl px-6 py-10 text-center">
          <p className="text-sm font-medium text-zinc-300">No agent activity in this range</p>
          <p className="text-xs text-zinc-500 mt-1">
            {filtered ? 'Try a wider date range, or clear the project and agent filters.' : 'Figures show here once your agents run, finish tasks or report usage.'}
          </p>
          {arranged.more > 0 && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setExpanded(true)}>Show every stat</Button>
          )}
        </div>
      )}

      {(measuring || (selected && chart)) && (
        <AnalyticsChart
          title={selected ? `${chart?.gran === 'month' ? 'Monthly' : chart?.gran === 'week' ? 'Weekly' : 'Daily'} ${TILE_META[selected].label.toLowerCase()}` : 'Daily runs'}
          aside="Stacked by agent"
          note={selected === 'profit' ? caveat : null}
          bars={chart?.bars ?? []}
          series={chart?.series ?? []}
          format={selected ? METRIC_FORMAT[selected] : 'count'}
          loading={measuring}
          empty={{
            title: selected === 'cost' && costLabel(s).kind === 'unpriced' ? 'All usage is unpriced' : `No ${selected ? TILE_META[selected].label.toLowerCase() : 'activity'} in this range`,
            detail: selected === 'cost' && costLabel(s).kind === 'unpriced'
              ? 'The provider sent no price for this usage (often a subscription). Pick Tokens to chart it.'
              : 'Try a wider date range, or clear the project and agent filters.',
          }}
        />
      )}

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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
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
        <section className="pt-2">
          <SectionHeader label="Delivery quality" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
            <QualityCard quality={quality} measuring={reopenQuery.loading} />
            <Card icon={Clock} title="Where work waits">
              {latency.length === 0 ? <CardSkeleton rows={3} /> : (
                <div className="divide-y divide-white/[0.06]">
                  {latency.map((stage) => (
                    <div key={stage.key} className="px-5 py-3 flex items-center justify-between gap-3">
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
        </section>
      )}
    </div>
  );
}
