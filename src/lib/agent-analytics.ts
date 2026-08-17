import type { AgentActivity, Project, TeamMember, TimeEntry } from '@/lib/types';
import { projectTimeEntryForBilling, type DateRange } from '@/lib/finance/summary';
import { getWorkedHoursByDay } from '@/lib/time-entry-utils';
import { EVENT_STATE, isAgentEventType } from '@/lib/agent-events';

export type TrackingState = 'tracked' | 'not_tracked';

export interface TrackedMetric {
  value: number | null;
  tracking: TrackingState;
}

export interface AgentAnalyticsRow {
  agentId: string;
  agentName: string;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  additions: number;
  deletions: number;
  linesChanged: number;
  revenue: number;
  hours: number;
  inputTokens: TrackedMetric;
  outputTokens: TrackedMetric;
  cachedTokens: TrackedMetric;
  modelCost: TrackedMetric;
  profit: TrackedMetric;
  /**
   * How long this agent actually ran, in milliseconds.
   *
   * A capacity measure, and INTERNAL ONLY: runtime never becomes a time entry,
   * never carries a rate, and never reaches the finance engine, which reads
   * project_time_entries alone. Only Jeff bills, through that separate path.
   */
  runtimeMs: TrackedMetric;
  /** Runtime spent on turns that produced work rather than finding none. */
  productiveRuntimeMs: TrackedMetric;
  /** Completed turns behind the runtime figures. */
  turns: number;
}

export interface AgentAnalyticsDay {
  dateKey: string;
  agentId: string;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  linesChanged: number;
  revenue: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  modelCost: number | null;
  profit: number | null;
  runtimeMs: number | null;
  productiveRuntimeMs: number | null;
}

export interface AgentAnalyticsData {
  agents: AgentAnalyticsRow[];
  daily: AgentAnalyticsDay[];
}

export interface AgentAnalyticsInput {
  activities: AgentActivity[];
  timeEntries: TimeEntry[];
  team: TeamMember[];
  projects: Project[];
  range: DateRange;
  now?: number;
  /** IANA timezone for day bucketing; defaults to the runtime's local zone. */
  timezone?: string;
  selectedAgentIds?: Set<string>;
  selectedProjectIds?: Set<string>;
}

interface MutableRow {
  agentId: string;
  agentName: string;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  additions: number;
  deletions: number;
  revenue: number;
  hours: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelCost: number;
  usageRecords: number;
  runtimeMs: number;
  productiveRuntimeMs: number;
  turns: number;
}

interface MutableDay {
  dateKey: string;
  agentId: string;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  linesChanged: number;
  revenue: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelCost: number;
  usageRecords: number;
  runtimeMs: number;
  productiveRuntimeMs: number;
  turns: number;
}

const numeric = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function normalizePullRequestUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(url.pathname);
    if (!match) return null;
    return `${url.hostname.toLowerCase()}/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`;
  } catch {
    return null;
  }
}

// Timestamps arrive as UTC ISO strings, but every range/"today" key on the
// consuming pages is a local calendar day. Bucketing by a raw UTC slice would
// push evening events onto the next day's bar, so day keys are derived in the
// caller's timezone (browser-local when none is given).
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const isoToDateKey = (iso: string, timeZone?: string): string => {
  const cacheKey = timeZone ?? 'local';
  let formatter = dateKeyFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateKeyFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(iso));
};

export function computeAgentAnalytics(input: AgentAnalyticsInput): AgentAnalyticsData {
  const now = input.now ?? Date.now();
  const agentMembers = input.team.filter(member => member.role === 'agent');
  const agentLookup = new Map(agentMembers.map(member => [member.id, member]));
  const projectLookup = new Map(input.projects.map(project => [project.id, project]));
  const includeAgent = (id: string) => !input.selectedAgentIds?.size || input.selectedAgentIds.has(id);
  const includeProject = (id: string | null) => !input.selectedProjectIds?.size || (!!id && input.selectedProjectIds.has(id));
  const inRange = (key: string) => key >= input.range.startKey && key <= input.range.endKey;

  const rows = new Map<string, MutableRow>();
  const days = new Map<string, MutableDay>();
  const getRow = (agentId: string): MutableRow | null => {
    const member = agentLookup.get(agentId);
    if (!member || !includeAgent(agentId)) return null;
    let row = rows.get(agentId);
    if (!row) {
      row = {
        agentId,
        agentName: member.name,
        prsOpened: 0,
        prsMerged: 0,
        reviewRounds: 0,
        additions: 0,
        deletions: 0,
        revenue: 0,
        hours: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelCost: 0,
        usageRecords: 0,
        runtimeMs: 0,
        productiveRuntimeMs: 0,
        turns: 0,
      };
      rows.set(agentId, row);
    }
    return row;
  };
  const getDay = (dateKey: string, agentId: string): MutableDay => {
    const key = `${dateKey}:${agentId}`;
    let day = days.get(key);
    if (!day) {
      day = {
        dateKey,
        agentId,
        prsOpened: 0,
        prsMerged: 0,
        reviewRounds: 0,
        linesChanged: 0,
        revenue: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelCost: 0,
        usageRecords: 0,
        runtimeMs: 0,
        productiveRuntimeMs: 0,
        turns: 0,
      };
      days.set(key, day);
    }
    return day;
  };

  for (const member of agentMembers) getRow(member.id);

  // Handoffs can be emitted more than once for the same PR. The first typed
  // handoff in the selected range owns the opened metric, and its agent is
  // also the preferred owner of the later merge event.
  const handoffOwnerByPr = new Map<string, string>();
  for (const activity of input.activities) {
    if (activity.activity_type !== 'work.handoff' || !includeProject(activity.project_id)) continue;
    const pr = normalizePullRequestUrl(activity.metadata?.pr_url);
    if (pr && agentLookup.has(activity.agent_id)) handoffOwnerByPr.set(pr, activity.agent_id);
  }
  const opened = new Set<string>();
  for (const activity of input.activities) {
    if (activity.activity_type !== 'work.handoff' || !includeProject(activity.project_id)) continue;
    const dateKey = isoToDateKey(activity.created_at, input.timezone);
    if (!inRange(dateKey)) continue;
    const pr = normalizePullRequestUrl(activity.metadata?.pr_url);
    if (!pr || opened.has(pr)) continue;
    const row = getRow(activity.agent_id);
    if (!row) continue;
    opened.add(pr);
    row.prsOpened += 1;
    getDay(dateKey, row.agentId).prsOpened += 1;
  }

  const merged = new Set<string>();
  const reviews = new Set<string>();
  const usageIds = new Set<string>();
  for (const activity of input.activities) {
    if (!includeProject(activity.project_id)) continue;
    const metadata = activity.metadata ?? {};
    const recordedAt = activity.activity_type === 'usage.recorded' && typeof metadata.recorded_at === 'string'
      ? metadata.recorded_at
      : activity.created_at;
    const dateKey = isoToDateKey(recordedAt, input.timezone);
    if (!inRange(dateKey)) continue;

    if (activity.activity_type === 'pr.merged') {
      const pr = normalizePullRequestUrl(metadata.pr_url);
      if (!pr || merged.has(pr)) continue;
      const ownerId = handoffOwnerByPr.get(pr) ?? activity.agent_id;
      const row = getRow(ownerId);
      if (!row) continue;
      const additions = numeric(metadata.additions);
      const deletions = numeric(metadata.deletions);
      merged.add(pr);
      row.prsMerged += 1;
      row.additions += additions;
      row.deletions += deletions;
      const day = getDay(dateKey, row.agentId);
      day.prsMerged += 1;
      day.linesChanged += additions + deletions;
      continue;
    }

    if (activity.activity_type === 'review.started' || activity.activity_type === 'review.verdict') {
      const subject = normalizePullRequestUrl(metadata.pr_url)
        ?? (typeof metadata.task_id === 'string' ? metadata.task_id : activity.reference_id)
        ?? activity.id;
      const round = numeric(metadata.round);
      const reviewKey = `${activity.agent_id}:${subject}:${round}`;
      if (reviews.has(reviewKey)) continue;
      const row = getRow(activity.agent_id);
      if (!row) continue;
      reviews.add(reviewKey);
      row.reviewRounds += 1;
      getDay(dateKey, row.agentId).reviewRounds += 1;
      continue;
    }

    if (activity.activity_type === 'usage.recorded') {
      const sourceId = typeof metadata.source_usage_id === 'string' ? metadata.source_usage_id : null;
      if (!sourceId || usageIds.has(sourceId)) continue;
      const row = getRow(activity.agent_id);
      if (!row) continue;
      usageIds.add(sourceId);
      const inputTokens = numeric(metadata.input_tokens);
      const outputTokens = numeric(metadata.output_tokens);
      const cachedTokens = numeric(metadata.cached_tokens);
      const cost = numeric(metadata.cost_usd);
      row.inputTokens += inputTokens;
      row.outputTokens += outputTokens;
      row.cachedTokens += cachedTokens;
      row.modelCost += cost;
      row.usageRecords += 1;
      const day = getDay(dateKey, row.agentId);
      day.inputTokens += inputTokens;
      day.outputTokens += outputTokens;
      day.cachedTokens += cachedTokens;
      day.modelCost += cost;
      day.usageRecords += 1;
    }
  }

  // ── Runtime: how long each agent actually ran ──────────────────────────
  // Classification lives here rather than in the host publisher, so what counts
  // as "productive" can be revised in the app without redeploying the VPS. The
  // publisher only reports facts: which turn, when, how long.
  //
  // A turn is productive when it overlaps an event proving the agent did
  // something. Turns that woke, found nothing, and logged `audit.no_work` or
  // `queue.empty` are real runtime but not real output, and the gap between the
  // two numbers is itself the signal: a fleet spending its day finding nothing.
  const workWindowsByAgent = new Map<string, number[]>();
  for (const activity of input.activities) {
    if (!isAgentEventType(activity.activity_type)) continue;
    if (EVENT_STATE[activity.activity_type] !== 'work') continue;
    if (!includeProject(activity.project_id)) continue;
    const at = Date.parse(activity.created_at);
    if (!Number.isFinite(at)) continue;
    const stamps = workWindowsByAgent.get(activity.agent_id);
    if (stamps) stamps.push(at); else workWindowsByAgent.set(activity.agent_id, [at]);
  }
  for (const stamps of workWindowsByAgent.values()) stamps.sort((a, b) => a - b);

  const turnIds = new Set<string>();
  for (const activity of input.activities) {
    if (activity.activity_type !== 'turn.completed') continue;
    const metadata = activity.metadata ?? {};
    const sourceId = typeof metadata.source_turn_id === 'string' ? metadata.source_turn_id : null;
    // Runtime is not project-scoped: a single turn can touch several projects
    // or none. Under a project filter, delivery and revenue narrow but runtime
    // would be a half-truth, so it is withheld rather than misattributed.
    if (!sourceId || turnIds.has(sourceId) || input.selectedProjectIds?.size) continue;
    const startedAt = typeof metadata.started_at === 'string' ? metadata.started_at : activity.created_at;
    const dateKey = isoToDateKey(startedAt, input.timezone);
    if (!inRange(dateKey)) continue;
    const row = getRow(activity.agent_id);
    if (!row) continue;
    turnIds.add(sourceId);

    const duration = numeric(metadata.duration_ms);
    const startMs = Date.parse(startedAt);
    const endMs = Number.isFinite(startMs) ? startMs + duration : NaN;
    const stamps = workWindowsByAgent.get(activity.agent_id) ?? [];
    const productive = Number.isFinite(startMs)
      && stamps.some(at => at >= startMs && at <= endMs);

    row.runtimeMs += duration;
    row.turns += 1;
    if (productive) row.productiveRuntimeMs += duration;
    const day = getDay(dateKey, row.agentId);
    day.runtimeMs += duration;
    day.turns += 1;
    if (productive) day.productiveRuntimeMs += duration;
  }

  for (const entry of input.timeEntries) {
    const row = getRow(entry.member_id);
    if (!row || !includeProject(entry.project_id) || entry.work_type === 'internal') continue;
    const project = projectLookup.get(entry.project_id);
    const rate = entry.hourly_rate ?? (project?.hourly_tracking ? project.hourly_rate ?? 0 : 0);
    const billingEntry = projectTimeEntryForBilling(entry, now);
    for (const [dateKey, hours] of getWorkedHoursByDay(billingEntry, now)) {
      if (!inRange(dateKey)) continue;
      const revenue = hours * rate;
      row.revenue += revenue;
      row.hours += hours;
      getDay(dateKey, row.agentId).revenue += revenue;
    }
  }

  const tracked = (value: number, isTracked: boolean): TrackedMetric => ({
    value: isTracked ? value : null,
    tracking: isTracked ? 'tracked' : 'not_tracked',
  });

  return {
    agents: Array.from(rows.values())
      .map(row => {
        const usageTracked = row.usageRecords > 0;
        return {
          agentId: row.agentId,
          agentName: row.agentName,
          prsOpened: row.prsOpened,
          prsMerged: row.prsMerged,
          reviewRounds: row.reviewRounds,
          additions: row.additions,
          deletions: row.deletions,
          linesChanged: row.additions + row.deletions,
          revenue: row.revenue,
          hours: row.hours,
          inputTokens: tracked(row.inputTokens, usageTracked),
          outputTokens: tracked(row.outputTokens, usageTracked),
          cachedTokens: tracked(row.cachedTokens, usageTracked),
          modelCost: tracked(row.modelCost, usageTracked),
          profit: tracked(row.revenue - row.modelCost, usageTracked),
          runtimeMs: tracked(row.runtimeMs, row.turns > 0),
          productiveRuntimeMs: tracked(row.productiveRuntimeMs, row.turns > 0),
          turns: row.turns,
        };
      })
      .sort((a, b) => b.revenue - a.revenue || a.agentName.localeCompare(b.agentName)),
    daily: Array.from(days.values())
      .map(day => ({
        dateKey: day.dateKey,
        agentId: day.agentId,
        prsOpened: day.prsOpened,
        prsMerged: day.prsMerged,
        reviewRounds: day.reviewRounds,
        linesChanged: day.linesChanged,
        revenue: day.revenue,
        inputTokens: day.usageRecords > 0 ? day.inputTokens : null,
        outputTokens: day.usageRecords > 0 ? day.outputTokens : null,
        cachedTokens: day.usageRecords > 0 ? day.cachedTokens : null,
        modelCost: day.usageRecords > 0 ? day.modelCost : null,
        profit: day.usageRecords > 0 ? day.revenue - day.modelCost : null,
        runtimeMs: day.turns > 0 ? day.runtimeMs : null,
        productiveRuntimeMs: day.turns > 0 ? day.productiveRuntimeMs : null,
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.agentId.localeCompare(b.agentId)),
  };
}

/** Bridge the analytics projection into computeFinanceAttribution. */
export function trackedAgentUsageCostByMember(data: AgentAnalyticsData): Map<string, number> {
  const costs = new Map<string, number>();
  for (const agent of data.agents) {
    if (agent.modelCost.tracking === 'tracked' && agent.modelCost.value !== null) {
      costs.set(agent.agentId, agent.modelCost.value);
    }
  }
  return costs;
}
