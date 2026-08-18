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
  /** Billable value of worked time still awaiting approval. Not in `revenue`. */
  pendingRevenue: number;
  pendingHours: number;
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
  /**
   * Runtime minus work that should not have happened. Derived, never stored:
   * `runtimeMs` remains the reconcilable measure, and this rule can change
   * without rewriting a single recorded turn.
   */
  effectiveRuntimeMs: TrackedMetric;
  /** Rebuilding or re-reviewing a pull request that was already approved. */
  reworkRuntimeMs: TrackedMetric;
  /** Turns that ran while the agent was blocked and could not proceed. */
  blockedRuntimeMs: TrackedMetric;
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
  effectiveRuntimeMs: number | null;
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
  pendingRevenue: number;
  pendingHours: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelCost: number;
  usageRecords: number;
  runtimeMs: number;
  productiveRuntimeMs: number;
  reworkRuntimeMs: number;
  blockedRuntimeMs: number;
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
  reworkRuntimeMs: number;
  blockedRuntimeMs: number;
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
        pendingRevenue: 0,
        pendingHours: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelCost: 0,
        usageRecords: 0,
        runtimeMs: 0,
        productiveRuntimeMs: 0,
        reworkRuntimeMs: 0,
        blockedRuntimeMs: 0,
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
        reworkRuntimeMs: 0,
        blockedRuntimeMs: 0,
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

  // Runtime is elapsed time, so overlapping turns must not be added together.
  // Agents do run turns concurrently: measured live, 19.8% of Jeff's summed
  // turn time was wall-clock counted twice, which would eventually report an
  // agent running more hours than the day contains. Intervals are collected
  // here, merged below, and only then summed. The stored events stay raw, so
  // this rule can be revised without republishing a single turn.
  // ── Waste: work that should not have happened ──────────────────────────
  //
  // Failure flags do not find it. Across 2,138 turns there were two unknown
  // statuses and one blocked event, while the nine-hour review loop that
  // prompted this produced no error at all: every turn completed and logged
  // real work. The waste looked exactly like success.
  //
  // What it does have is a signature. A verdict is about a commit, and the
  // first verdict on a commit is final, so once a pull request is approved any
  // further work on it is by definition redundant. That is measurable from
  // events already stored, and it is a rule rather than a guess.
  // Verdicts are keyed by task, not by pull request: the events carry
  // `task_id` and no PR link, so the task is the only join available.
  //
  // A round of 1 opens a fresh review cycle, which is how a replacement pull
  // request announces itself. Treating that as a reset stops a stale approval
  // from condemning legitimate work on a new PR for the same task.
  const verdictTimeline = new Map<string, { at: number; approved: boolean }[]>();
  for (const activity of input.activities) {
    if (activity.activity_type !== 'review.verdict') continue;
    const metadata = activity.metadata ?? {};
    const taskId = typeof metadata.task_id === 'string' ? metadata.task_id : activity.reference_id;
    if (!taskId) continue;
    const at = Date.parse(activity.created_at);
    if (!Number.isFinite(at)) continue;
    const approved = metadata.verdict === 'approved';
    const isNewCycle = numeric(metadata.round) === 1;
    // Only two things matter for this question: a moment work became
    // redundant (an approval), and a moment that stopped being true (a new
    // cycle that was not itself an approval).
    if (!approved && !isNewCycle) continue;
    const list = verdictTimeline.get(taskId);
    if (list) list.push({ at, approved }); else verdictTimeline.set(taskId, [{ at, approved }]);
  }
  for (const list of verdictTimeline.values()) list.sort((a, b) => a.at - b.at);

  /** Was this task's work already approved, and still approved, at this moment? */
  const approvedBefore = (taskId: string, moment: number): boolean => {
    const list = verdictTimeline.get(taskId);
    if (!list) return false;
    let approved = false;
    for (const entry of list) {
      if (entry.at >= moment) break;
      approved = entry.approved;
    }
    return approved;
  };

  // Every event that names a task, so a turn can be tested against the tasks it
  // touched rather than against a task it was merely near.
  const taskTouchesByAgent = new Map<string, { at: number; taskId: string }[]>();
  const blockedByAgent = new Map<string, number[]>();
  for (const activity of input.activities) {
    const at = Date.parse(activity.created_at);
    if (!Number.isFinite(at)) continue;
    if (activity.activity_type === 'blocked') {
      const list = blockedByAgent.get(activity.agent_id);
      if (list) list.push(at); else blockedByAgent.set(activity.agent_id, [at]);
      continue;
    }
    const metadata = activity.metadata ?? {};
    const taskId = typeof metadata.task_id === 'string' ? metadata.task_id : activity.reference_id;
    if (!taskId) continue;
    const list = taskTouchesByAgent.get(activity.agent_id);
    if (list) list.push({ at, taskId }); else taskTouchesByAgent.set(activity.agent_id, [{ at, taskId }]);
  }

  const turnIds = new Set<string>();
  const intervalsByAgent = new Map<string, {
    start: number; end: number; productive: boolean; rework: boolean; blocked: boolean;
  }[]>();
  const turnsByAgent = new Map<string, number>();
  for (const activity of input.activities) {
    if (activity.activity_type !== 'turn.completed') continue;
    const metadata = activity.metadata ?? {};
    const sourceId = typeof metadata.source_turn_id === 'string' ? metadata.source_turn_id : null;
    // Runtime is not project-scoped: a single turn can touch several projects
    // or none. Under a project filter, delivery and revenue narrow but runtime
    // would be a half-truth, so it is withheld rather than misattributed.
    if (!sourceId || turnIds.has(sourceId) || input.selectedProjectIds?.size) continue;
    const startedAt = typeof metadata.started_at === 'string' ? metadata.started_at : activity.created_at;
    if (!inRange(isoToDateKey(startedAt, input.timezone))) continue;
    const row = getRow(activity.agent_id);
    if (!row) continue;
    const startMs = Date.parse(startedAt);
    if (!Number.isFinite(startMs)) continue;
    turnIds.add(sourceId);

    const endMs = startMs + numeric(metadata.duration_ms);
    const stamps = workWindowsByAgent.get(activity.agent_id) ?? [];
    const productive = stamps.some(at => at >= startMs && at <= endMs);

    // Rework: this turn touched a task whose pull request had already been
    // approved before the turn began. Rebuilding approved work, or reviewing an
    // approved commit again, is time the fleet should never have spent.
    const touches = taskTouchesByAgent.get(activity.agent_id) ?? [];
    const rework = touches.some(touch =>
      touch.at >= startMs && touch.at <= endMs && approvedBefore(touch.taskId, startMs));
    const blocked = (blockedByAgent.get(activity.agent_id) ?? [])
      .some(at => at >= startMs && at <= endMs);

    const list = intervalsByAgent.get(row.agentId);
    const interval = { start: startMs, end: endMs, productive, rework, blocked };
    if (list) list.push(interval);
    else intervalsByAgent.set(row.agentId, [interval]);
    turnsByAgent.set(row.agentId, (turnsByAgent.get(row.agentId) ?? 0) + 1);
  }

  type RuntimeBucket = 'runtimeMs' | 'productiveRuntimeMs' | 'reworkRuntimeMs' | 'blockedRuntimeMs';

  /**
   * Merge overlapping spans, then credit each merged span to the days it covers.
   *
   * Each bucket merges independently, so a turn counted as rework is subtracted
   * exactly once even when it overlapped another turn: every measure here is
   * elapsed time, and elapsed time cannot be double counted in either direction.
   */
  const creditRuntime = (agentId: string, spans: { start: number; end: number }[], bucket: RuntimeBucket) => {
    const row = rows.get(agentId);
    if (!row) return;
    const sorted = spans.slice().sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const span of sorted) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ start: span.start, end: span.end });
    }
    for (const span of merged) {
      // A turn can cross local midnight; each day keeps only its own share so
      // the daily series still sums to the range total.
      let cursor = span.start;
      while (cursor < span.end) {
        const dateKey = isoToDateKey(new Date(cursor).toISOString(), input.timezone);
        const dayEnd = new Date(cursor);
        dayEnd.setHours(23, 59, 59, 999);
        const sliceEnd = Math.min(span.end, dayEnd.getTime() + 1);
        const slice = sliceEnd - cursor;
        if (inRange(dateKey)) {
          row[bucket] += slice;
          getDay(dateKey, agentId)[bucket] += slice;
        }
        cursor = sliceEnd;
      }
    }
  };

  for (const [agentId, intervals] of intervalsByAgent) {
    creditRuntime(agentId, intervals, 'runtimeMs');
    creditRuntime(agentId, intervals.filter(i => i.productive), 'productiveRuntimeMs');
    creditRuntime(agentId, intervals.filter(i => i.rework), 'reworkRuntimeMs');
    // Blocked time that is also rework is already excluded; counting it in both
    // would subtract the same minutes twice from effective runtime.
    creditRuntime(agentId, intervals.filter(i => i.blocked && !i.rework), 'blockedRuntimeMs');
    const row = rows.get(agentId);
    const turns = turnsByAgent.get(agentId) ?? 0;
    if (row) row.turns += turns;
    // The day rows carry their own turn counts for the chart's tooltip.
    for (const interval of intervals) {
      const dateKey = isoToDateKey(new Date(interval.start).toISOString(), input.timezone);
      if (inRange(dateKey)) getDay(dateKey, agentId).turns += 1;
    }
  }

  for (const entry of input.timeEntries) {
    const row = getRow(entry.member_id);
    if (!row || !includeProject(entry.project_id) || entry.work_type === 'internal') continue;
    const project = projectLookup.get(entry.project_id);
    const rate = entry.hourly_rate ?? (project?.hourly_tracking ? project.hourly_rate ?? 0 : 0);
    const billingEntry = projectTimeEntryForBilling(entry, now);
    // Approval turns worked time into revenue. Before it, the hours are real
    // and the money is not: counting it early meant reviewing a session and
    // rejecting part of it made reported earnings fall, which is the opposite
    // of what a ledger should do. Pending value is reported separately.
    const approved = entry.approval_status === 'approved';
    for (const [dateKey, hours] of getWorkedHoursByDay(billingEntry, now)) {
      if (!inRange(dateKey)) continue;
      const revenue = hours * rate;
      if (approved) {
        row.revenue += revenue;
        row.hours += hours;
        getDay(dateKey, row.agentId).revenue += revenue;
      } else {
        row.pendingRevenue += revenue;
        row.pendingHours += hours;
      }
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
          pendingRevenue: row.pendingRevenue,
          pendingHours: row.pendingHours,
          inputTokens: tracked(row.inputTokens, usageTracked),
          outputTokens: tracked(row.outputTokens, usageTracked),
          cachedTokens: tracked(row.cachedTokens, usageTracked),
          modelCost: tracked(row.modelCost, usageTracked),
          profit: tracked(row.revenue - row.modelCost, usageTracked),
          runtimeMs: tracked(row.runtimeMs, row.turns > 0),
          productiveRuntimeMs: tracked(row.productiveRuntimeMs, row.turns > 0),
          effectiveRuntimeMs: tracked(
            Math.max(0, row.runtimeMs - row.reworkRuntimeMs - row.blockedRuntimeMs),
            row.turns > 0,
          ),
          reworkRuntimeMs: tracked(row.reworkRuntimeMs, row.turns > 0),
          blockedRuntimeMs: tracked(row.blockedRuntimeMs, row.turns > 0),
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
        effectiveRuntimeMs: day.turns > 0
          ? Math.max(0, day.runtimeMs - day.reworkRuntimeMs - day.blockedRuntimeMs)
          : null,
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.agentId.localeCompare(b.agentId)),
  };
}

// ── Pipeline latency ────────────────────────────────────────────────────────

export interface LatencyStage {
  key: 'review' | 'fix' | 'merge';
  label: string;
  /** Null when nothing in range could be measured, never zero as a stand-in. */
  medianMs: number | null;
  worstMs: number | null;
  samples: number;
  /** True when the stage has no telemetry at all rather than no occurrences. */
  notTracked: boolean;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * Where work waits between hands.
 *
 * Runtime says how long the agents ran; this says how long work sat still,
 * which is usually the larger number and the one a human can act on. Measured
 * from events already stored: no new telemetry, and each stage reports the
 * median plus the worst case, because an average hides the stuck one.
 */
export function computePipelineLatency(
  activities: AgentActivity[],
  range: DateRange,
  timezone?: string,
): LatencyStage[] {
  interface Moment { at: number; kind: 'handoff' | 'approved' | 'changes' | 'merged' }
  const byTask = new Map<string, Moment[]>();
  let sawMergeEvent = false;

  for (const activity of activities) {
    const metadata = activity.metadata ?? {};
    const taskId = typeof metadata.task_id === 'string' ? metadata.task_id : activity.reference_id;
    const at = Date.parse(activity.created_at);
    if (!taskId || !Number.isFinite(at)) continue;
    let kind: Moment['kind'] | null = null;
    if (activity.activity_type === 'work.handoff') kind = 'handoff';
    else if (activity.activity_type === 'pr.merged') { kind = 'merged'; sawMergeEvent = true; }
    else if (activity.activity_type === 'review.verdict') {
      kind = metadata.verdict === 'approved' ? 'approved' : 'changes';
    }
    if (!kind) continue;
    const list = byTask.get(taskId);
    if (list) list.push({ at, kind }); else byTask.set(taskId, [{ at, kind }]);
  }

  const waits = { review: [] as number[], fix: [] as number[], merge: [] as number[] };
  const inRange = (at: number) => {
    const key = isoToDateKey(new Date(at).toISOString(), timezone);
    return key >= range.startKey && key <= range.endKey;
  };

  for (const moments of byTask.values()) {
    moments.sort((a, b) => a.at - b.at);
    for (let i = 0; i < moments.length; i++) {
      const from = moments[i];
      // The next moment of the kind this stage waits for. Repeated handoffs
      // without a verdict between them are one wait, not several.
      const next = moments.slice(i + 1).find(m =>
        from.kind === 'handoff' ? (m.kind === 'approved' || m.kind === 'changes')
        : from.kind === 'changes' ? m.kind === 'handoff'
        : from.kind === 'approved' ? m.kind === 'merged'
        : false);
      if (!next || !inRange(from.at)) continue;
      const waited = next.at - from.at;
      if (waited < 0) continue;
      if (from.kind === 'handoff') waits.review.push(waited);
      else if (from.kind === 'changes') waits.fix.push(waited);
      else if (from.kind === 'approved') waits.merge.push(waited);
    }
  }

  return [
    { key: 'review' as const, label: 'Handoff to verdict', values: waits.review, notTracked: false },
    { key: 'fix' as const, label: 'Verdict to fix', values: waits.fix, notTracked: false },
    // A merge wait cannot be measured before merge telemetry exists, and
    // reporting zero would read as "merged instantly".
    { key: 'merge' as const, label: 'Approval to merge', values: waits.merge, notTracked: !sawMergeEvent },
  ].map(stage => ({
    key: stage.key,
    label: stage.label,
    medianMs: median(stage.values),
    worstMs: stage.values.length ? Math.max(...stage.values) : null,
    samples: stage.values.length,
    notTracked: stage.notTracked,
  }));
}

// ── Availability ────────────────────────────────────────────────────────────

export interface AgentHealthTransition {
  member_id: string;
  container_running: boolean;
  changed_at: string;
}

export interface AvailabilityRow {
  agentId: string;
  agentName: string;
  upMs: number;
  downMs: number;
  /** Null until the range contains observed history. */
  uptimePct: number | null;
  /** When observation began, so a short window is never read as a short outage. */
  measuredSince: string | null;
  outages: number;
}

/**
 * Uptime from recorded state transitions.
 *
 * Only changes are stored, so a state persists until the next transition and
 * the window is measured from first observation rather than from the start of
 * the range. Reporting 100% for a period nobody watched would be the same lie
 * as reporting zero.
 */
export function computeAvailability(
  transitions: AgentHealthTransition[],
  team: TeamMember[],
  range: DateRange,
  now: number,
): AvailabilityRow[] {
  const agents = team.filter(member => member.role === 'agent');
  const rangeStart = Date.parse(`${range.startKey}T00:00:00.000Z`);
  const rangeEnd = Math.min(now, Date.parse(`${range.endKey}T23:59:59.999Z`));

  return agents.map(member => {
    const mine = transitions
      .filter(t => t.member_id === member.id)
      .map(t => ({ at: Date.parse(t.changed_at), up: t.container_running }))
      .filter(t => Number.isFinite(t.at))
      .sort((a, b) => a.at - b.at);

    if (mine.length === 0) {
      return {
        agentId: member.id, agentName: member.name, upMs: 0, downMs: 0,
        uptimePct: null, measuredSince: null, outages: 0,
      };
    }

    // Observation starts at the first transition inside the range, or at the
    // range start when an earlier transition already establishes the state.
    const before = mine.filter(t => t.at <= rangeStart).pop();
    const inside = mine.filter(t => t.at > rangeStart && t.at <= rangeEnd);
    const start = before ? rangeStart : inside[0]?.at;
    if (start === undefined) {
      return {
        agentId: member.id, agentName: member.name, upMs: 0, downMs: 0,
        uptimePct: null, measuredSince: null, outages: 0,
      };
    }

    let cursor = start;
    let state = before ? before.up : inside[0].up;
    let upMs = 0;
    let downMs = 0;
    let outages = 0;
    for (const change of inside) {
      if (change.at <= cursor) { state = change.up; continue; }
      const span = change.at - cursor;
      if (state) upMs += span; else downMs += span;
      if (state && !change.up) outages += 1;
      cursor = change.at;
      state = change.up;
    }
    if (rangeEnd > cursor) {
      const span = rangeEnd - cursor;
      if (state) upMs += span; else downMs += span;
    }
    const observed = upMs + downMs;
    return {
      agentId: member.id,
      agentName: member.name,
      upMs,
      downMs,
      uptimePct: observed > 0 ? (upMs / observed) * 100 : null,
      measuredSince: new Date(start).toISOString(),
      outages,
    };
  });
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
