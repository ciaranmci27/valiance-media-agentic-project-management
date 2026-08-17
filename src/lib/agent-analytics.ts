import type { AgentActivity, Project, TeamMember, TimeEntry } from '@/lib/types';
import { projectTimeEntryForBilling, type DateRange } from '@/lib/finance/summary';
import { getWorkedHoursByDay } from '@/lib/time-entry-utils';

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
