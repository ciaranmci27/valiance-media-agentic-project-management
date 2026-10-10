import type { AgentActivity, FleetAgentActivity, TaskSuggestion, TeamMember } from '@/lib/types';
import type { DateRange } from '@/lib/finance/summary';
import { EVENT_STATE, isAgentEventType, isTelemetryEvent, TURN_OUTCOMES, type TurnOutcome } from '@/lib/agent-events';
import { normalizePullRequestUrl } from '@/lib/agent-analytics';

/**
 * The honest read model for host telemetry (docs/12-telemetry.md in the
 * agents repo): where every minute of agent runtime went, what the tokens
 * bought, how often Ciaran was interrupted, and how reliable the fleet was.
 *
 * Rules this file keeps:
 * - Every kind of time is tracked and labelled; none is folded into another.
 *   A turn without an outcome (published before outcomes existed) is
 *   `unlabelled`: never work, never idle. A directed (Telegram) turn is work,
 *   because a person started it.
 * - Effective runtime is outcome work only, minus rework on approved work.
 * - Lines are elapsed time. Overlapping turns of one agent are counted once,
 *   so the lines always sum to active runtime (see `sweep`).
 * - Turn tokens attribute the usage ledger; they are never added to it.
 * - Nothing missing becomes a zero: a stream that has not reported returns
 *   null or an empty list, and the page says what is missing.
 */

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A runtime line. `rework` is the part of work spent on already-approved work. */
export type TimeLine = 'work' | 'rework' | 'blocked' | 'waiting' | 'idle' | 'skipped' | 'unknown' | 'unlabelled' | 'failed';

/**
 * When two of an agent's turns overlap, the instant belongs to the most
 * meaningful line: real work outranks rework, which outranks the states that
 * produced nothing. A failed fire ranks last because anything else that ran
 * at the same moment says more about what the agent was doing.
 */
export const TIME_LINES: TimeLine[] = ['work', 'rework', 'blocked', 'waiting', 'idle', 'skipped', 'unknown', 'unlabelled', 'failed'];

export type TurnTrigger = 'schedule' | 'direct' | 'telegram' | 'unrecorded';

export interface Turn {
  id: string;
  agentId: string;
  sourceTurnId: string;
  origin: 'scheduled' | 'directed';
  start: number;
  end: number;
  durationMs: number;
  outcome: TurnOutcome | 'unlabelled';
  /** The outcome came from turn.outcome (backfill), not the live publisher. */
  backfilled: boolean;
  jobName: string | null;
  trigger: TurnTrigger;
  sessionId: string | null;
  model: string | null;
  /** This turn's own tokens (scheduled, tokens_scope turn); null otherwise. */
  turnTokens: number | null;
  tokensScope: 'turn' | 'session_usage' | null;
}

export interface FailedTurn {
  id: string;
  agentId: string;
  sourceTurnId: string;
  failure: 'failed' | 'unknown' | 'completed_with_error' | 'dead';
  hasCompletedTurn: boolean;
  start: number | null;
  end: number | null;
  durationMs: number | null;
  /** When it happened, for listing: finish, else start, else when it was recorded. */
  at: number;
  error: string | null;
  jobName: string | null;
  trigger: TurnTrigger;
}

export type LineTotals = Record<TimeLine, number>;

export interface TimeAccounting {
  activeMs: number;
  lines: LineTotals;
  /** work minus rework: the only time that displaced work a person would do. */
  effectiveMs: number;
  /** All work, rework included, over active runtime. Null with no runtime. */
  productiveShare: number | null;
  turns: number;
  /** Turns per line (a turn counts under its own label, overlap or not). */
  turnCounts: Record<TurnOutcome | 'unlabelled', number>;
  unknownTurns: number;
  unlabelledTurns: number;
  /** Every failed fire, completed_with_error included. */
  failedRuns: number;
  /** Failed fires with no completed turn: the ones whose runtime is the Failed line. */
  failedWithoutTurn: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** Summed turn durations for this slice (a slice is rarely concurrent with itself). */
  activeMs: number;
  workMs: number;
  idleMs: number;
  waitingMs: number;
  blockedMs: number;
  skippedMs: number;
  otherMs: number;
  turns: number;
  productiveShare: number | null;
}

export interface OutcomeDay {
  dateKey: string;
  lines: LineTotals;
}

export interface TokenSlice {
  outcome: TurnOutcome | 'unlabelled';
  tokens: number;
  turns: number;
}

export interface TokenView {
  /** Usage-ledger tokens in range (input + output + cached): the total. */
  ledgerTokens: number | null;
  /** Of those, tokens attributed to a turn (scheduled turn tokens, or directed windows). */
  attributedTokens: number;
  byOutcome: TokenSlice[];
  /** idle + waiting + skipped over attributed. Null when nothing is attributed. */
  idleShare: number | null;
  perAgent: {
    agentId: string;
    agentName: string;
    ledgerTokens: number | null;
    mergedPrs: number;
    acceptedSuggestions: number;
    tasksWorked: number;
    perMergedPr: number | null;
    perAcceptedSuggestion: number | null;
    perTask: number | null;
  }[];
}

export interface AttentionRow {
  /** null = Fleet (host alerts that name no agent). */
  agentId: string | null;
  name: string;
  total: number;
  solicited: number;
  unsolicited: number;
  byKind: Record<string, number>;
  /** Unsolicited messages per day of the range, oldest first. */
  dailyUnsolicited: number[];
}

export interface Attention {
  rows: AttentionRow[];
  total: number;
  hostAlertShare: number | null;
  blockingByTask: { taskId: string; count: number }[];
  blockedToResume: {
    samples: number;
    medianMs: number | null;
    p95Ms: number | null;
    /** Blocked events with no later progress on that task (still waiting). */
    unresolved: number;
  };
  /** False until any attention.message exists at all. */
  tracked: boolean;
}

export interface Quality {
  approvals: number;
  firstPass: number;
  firstPassRate: number | null;
  reviewRounds: number;
  tasksReviewed: number;
  roundsPerTask: number | null;
  reopened: number | null;
  reopenedSince: string | null;
  mergedPrs: number;
  /**
   * Reverts found among merge events, a LOWER BOUND: merge events come only
   * from Jeff's merge scripts, and a revert is usually made and merged by a
   * person in GitHub, which sends no event. So a count of zero is never
   * claimed: null unless at least one revert was found.
   */
  revertedAtLeast: number | null;
  /** Whether any merge event carries a PR title (detection needs titles). */
  revertTitlesReported: boolean;
  revertedPrs: { prUrl: string; revertUrl: string }[];
}

export interface Reliability {
  failures: FailedTurn[];
  failureRates: { agentId: string; agentName: string; jobName: string; failures: number; runs: number; rate: number }[];
  restarts: { id: string; agentId: string; agentName: string; kind: string; at: number; deployCommit: string | null }[];
  overlaps: {
    agentId: string;
    agentName: string;
    pairs: number;
    overlapMs: number;
    examples: { first: Turn; second: Turn; overlapMs: number }[];
  }[];
  handoff: { samples: number; p50Seconds: number | null; p95Seconds: number | null };
  wakes: { stateChange: number; continuation: number; yielded: number };
  tracked: { failures: boolean; restarts: boolean; wakes: boolean };
}

export interface BillingGap {
  id: string;
  agentId: string;
  start: number;
  end: number;
  minutes: number;
  phase: 'before_timer' | 'mid_turn' | 'after_timer' | 'unbilled_turn';
  origin: string | null;
  sourceTurnId: string;
  taskId: string | null;
  review: GapReview | null;
}

export interface GapReview {
  activity_id: string;
  status: 'reconciled' | 'dismissed';
  note: string;
  reviewed_at: string;
}

export interface ModelRun {
  model: string;
  from: number;
  to: number;
  turns: number;
}

export interface EvalPoint {
  id: string;
  suite: string;
  at: number;
  score: number;
  total: number;
  pct: number | null;
  complete: boolean;
  model: string | null;
  failedCases: string[];
}

export interface TelemetryAnalytics {
  turns: Turn[];
  fleet: TimeAccounting;
  perAgent: { agentId: string; agentName: string; accounting: TimeAccounting }[];
  byJob: BreakdownRow[];
  byTrigger: BreakdownRow[];
  byAgent: BreakdownRow[];
  daily: OutcomeDay[];
  tokens: TokenView;
  attention: Attention;
  quality: Quality;
  reliability: Reliability;
  billingGaps: BillingGap[];
  models: { agentId: string; agentName: string; runs: ModelRun[] }[];
  evals: { suite: string; points: EvalPoint[] }[];
  /** Whether any turn in range carries an outcome yet. */
  outcomesReported: boolean;
}

/** A fleet-level row: host alerts that name no agent. */
export type FleetActivity = FleetAgentActivity;

export interface TelemetryInput {
  activities: AgentActivity[];
  fleetActivities?: FleetActivity[];
  team: TeamMember[];
  range: DateRange;
  timezone?: string;
  now?: number;
  selectedAgentIds?: Set<string>;
  selectedProjectIds?: Set<string>;
  suggestions?: TaskSuggestion[];
  /** null when reopen tracking does not exist yet; see Quality.reopened. */
  reopens?: { task_id: string; project_id: string | null; reopened_at: string }[] | null;
  reopenTrackingSince?: string | null;
  gapReviews?: GapReview[];
  /** Merged PRs per agent from the delivery read model (the same dedupe). */
  mergedPrsByAgent?: Map<string, number>;
  /** Usage-ledger tokens per agent in range; null for an agent with none. */
  ledgerTokensByAgent?: Map<string, number | null>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const time = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  // The evals' own stamp: 20261010T190000Z.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
export function dateKeyOf(ms: number, timeZone?: string): string {
  const cacheKey = timeZone ?? 'local';
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(ms));
}

/** Nearest-rank percentile: the smallest sample at or above p of the samples. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

const emptyLines = (): LineTotals => ({
  work: 0, rework: 0, blocked: 0, waiting: 0, idle: 0, skipped: 0, unknown: 0, unlabelled: 0, failed: 0,
});

const triggerOf = (origin: string, trigger: unknown): TurnTrigger =>
  origin === 'directed' ? 'telegram' : trigger === 'schedule' || trigger === 'direct' ? trigger : 'unrecorded';

function tokenTotal(tokens: unknown): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  // Reasoning tokens are part of output; adding them would count them twice.
  return num(t.input) + num(t.output) + num(t.cache_read) + num(t.cache_write);
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Every turn.completed as a Turn. A turn.outcome still stored as its own row
 * (its turn had not arrived) is folded in here too, so a label is never lost
 * to arrival order. Turns dedupe on (agent, source_turn_id).
 */
export function normalizeTurns(activities: AgentActivity[]): Turn[] {
  const labels = new Map<string, Record<string, unknown>>();
  for (const a of activities) {
    if (a.activity_type !== 'turn.outcome') continue;
    const id = str(a.metadata?.source_turn_id);
    if (id) labels.set(`${a.agent_id}:${id}`, a.metadata ?? {});
  }
  const seen = new Set<string>();
  const turns: Turn[] = [];
  for (const a of activities) {
    if (a.activity_type !== 'turn.completed') continue;
    const sourceTurnId = str(a.metadata?.source_turn_id);
    if (!sourceTurnId) continue;
    const key = `${a.agent_id}:${sourceTurnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Same rule as the API merge: a waiting label fills only what the turn lacks.
    const label = labels.get(key);
    let m: Record<string, unknown> = a.metadata ?? {};
    const relabel = m.outcome === 'unknown' && typeof label?.outcome === 'string' && label.outcome !== 'unknown';
    if (label && (typeof m.outcome !== 'string' || relabel)) {
      m = { ...m };
      if (relabel) m.outcome = label.outcome;
      for (const [field, value] of Object.entries(label)) if (m[field] === undefined) m[field] = value;
      m.outcome_source = 'backfill';
    }
    const start = time(m.started_at) ?? time(a.created_at);
    if (start === null) continue;
    const durationMs = num(m.duration_ms);
    const origin = m.origin === 'directed' ? 'directed' : 'scheduled';
    const labelled = TURN_OUTCOMES.includes(m.outcome as TurnOutcome) ? (m.outcome as TurnOutcome) : null;
    turns.push({
      id: a.id,
      agentId: a.agent_id,
      sourceTurnId,
      origin,
      start,
      end: start + durationMs,
      durationMs,
      // A person started every directed turn, so it is work whether or not
      // the row predates outcomes. That is the contract's rule, not a guess.
      outcome: labelled ?? (origin === 'directed' ? 'work' : 'unlabelled'),
      backfilled: m.outcome_source === 'backfill',
      jobName: str(m.job_name),
      trigger: triggerOf(origin, m.trigger),
      sessionId: str(m.session_id),
      model: str(m.model),
      turnTokens: m.tokens_scope === 'turn' ? tokenTotal(m.tokens) : null,
      tokensScope: m.tokens_scope === 'turn' || m.tokens_scope === 'session_usage' ? m.tokens_scope : null,
    });
  }
  return turns;
}

export function normalizeFailures(activities: AgentActivity[]): FailedTurn[] {
  const seen = new Set<string>();
  const out: FailedTurn[] = [];
  for (const a of activities) {
    if (a.activity_type !== 'turn.failed') continue;
    const m = a.metadata ?? {};
    const sourceTurnId = str(m.source_turn_id);
    if (!sourceTurnId) continue;
    const key = `${a.agent_id}:${sourceTurnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = time(m.started_at);
    const end = time(m.finished_at);
    const durationMs = typeof m.duration_ms === 'number' && m.duration_ms >= 0 ? m.duration_ms : null;
    out.push({
      id: a.id,
      agentId: a.agent_id,
      sourceTurnId,
      failure: (['failed', 'unknown', 'completed_with_error', 'dead'].includes(String(m.failure)) ? m.failure : 'failed') as FailedTurn['failure'],
      hasCompletedTurn: m.has_completed_turn === true,
      start,
      end,
      durationMs,
      at: end ?? start ?? Date.parse(a.created_at),
      error: str(m.error),
      jobName: str(m.job_name),
      trigger: triggerOf('scheduled', m.trigger),
    });
  }
  return out;
}

// ── Elapsed-time sweep ──────────────────────────────────────────────────────

interface Span { start: number; end: number; line: TimeLine }

/**
 * Turn spans into non-overlapping elapsed segments, each owned by the highest
 * ranked line active at that moment (TIME_LINES order). The segments' total
 * is the union of the spans, so lines sum exactly to active runtime and
 * concurrent turns are never counted twice in either direction.
 */
export function sweep(spans: Span[]): Span[] {
  const rank = new Map(TIME_LINES.map((line, i) => [line, i]));
  const edges: { at: number; line: TimeLine; delta: 1 | -1 }[] = [];
  for (const s of spans) {
    if (!(s.end > s.start)) continue;
    edges.push({ at: s.start, line: s.line, delta: 1 }, { at: s.end, line: s.line, delta: -1 });
  }
  edges.sort((a, b) => a.at - b.at);
  const active = new Array(TIME_LINES.length).fill(0) as number[];
  const out: Span[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < edges.length; ) {
    const at = edges[i].at;
    if (cursor !== null && at > cursor) {
      const top = active.findIndex((count) => count > 0);
      if (top >= 0) {
        const line = TIME_LINES[top];
        const last = out[out.length - 1];
        if (last && last.line === line && last.end === cursor) last.end = at;
        else out.push({ start: cursor, end: at, line });
      }
    }
    while (i < edges.length && edges[i].at === at) {
      active[rank.get(edges[i].line)!] += edges[i].delta;
      i++;
    }
    cursor = at;
  }
  return out;
}

/** Split [start, end) at the timezone's local midnights, yielding each day's share. */
function* daySlices(start: number, end: number, timeZone?: string): Generator<{ dateKey: string; ms: number }> {
  let cursor = start;
  while (cursor < end) {
    const key = dateKeyOf(cursor, timeZone);
    if (dateKeyOf(end - 1, timeZone) === key) {
      yield { dateKey: key, ms: end - cursor };
      return;
    }
    // Binary search the first millisecond of the next local day.
    let lo = cursor;
    let hi = end - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (dateKeyOf(mid, timeZone) === key) lo = mid; else hi = mid;
    }
    yield { dateKey: key, ms: hi - cursor };
    cursor = hi;
  }
}

// ── Rework ──────────────────────────────────────────────────────────────────

/**
 * Work on a task whose pull request was already approved, and still approved,
 * when the turn began (the rule the delivery read model has always used): a
 * verdict is about a commit and the first one is final, so further work on an
 * approved PR is redundant by definition. A round-1 verdict opens a new cycle.
 */
// Events that name a task without being work on it: host telemetry (posted
// whenever the host gets to it, not when the agent acted) and the normal
// finishing steps after an approval (merge, close, timer bookkeeping).
const NOT_A_TOUCH = new Set(['pr.merged', 'work.done', 'review.verdict']);
const isTouch = (type: string) => !isTelemetryEvent(type) && !NOT_A_TOUCH.has(type) && !type.startsWith('billing.');

function reworkTest(activities: AgentActivity[]) {
  const timeline = new Map<string, { at: number; approved: boolean }[]>();
  const touches = new Map<string, { at: number; taskId: string }[]>();
  for (const a of activities) {
    const at = Date.parse(a.created_at);
    if (!Number.isFinite(at)) continue;
    const m = a.metadata ?? {};
    const taskId = str(m.task_id) ?? a.reference_id;
    if (!taskId) continue;
    if (a.activity_type === 'review.verdict') {
      const approved = m.verdict === 'approved';
      if (approved || num(m.round) === 1) {
        const list = timeline.get(taskId) ?? [];
        list.push({ at, approved });
        timeline.set(taskId, list);
      }
    }
    if (!isTouch(a.activity_type)) continue;
    const list = touches.get(a.agent_id) ?? [];
    list.push({ at, taskId });
    touches.set(a.agent_id, list);
  }
  for (const list of timeline.values()) list.sort((x, y) => x.at - y.at);
  const approvedBefore = (taskId: string, moment: number) => {
    let approved = false;
    for (const entry of timeline.get(taskId) ?? []) {
      if (entry.at >= moment) break;
      approved = entry.approved;
    }
    return approved;
  };
  return (turn: Turn) =>
    (touches.get(turn.agentId) ?? []).some((touch) =>
      touch.at >= turn.start && touch.at <= turn.end && approvedBefore(touch.taskId, turn.start));
}

// ── The read model ──────────────────────────────────────────────────────────

export function computeTelemetryAnalytics(input: TelemetryInput): TelemetryAnalytics {
  const tz = input.timezone;
  const agents = input.team.filter((m) => m.role === 'agent');
  const nameOf = new Map(agents.map((m) => [m.id, m.name]));
  const includeAgent = (id: string) => nameOf.has(id) && (!input.selectedAgentIds?.size || input.selectedAgentIds.has(id));
  const projectFiltered = Boolean(input.selectedProjectIds?.size);
  const includeProject = (id: string | null | undefined) => !projectFiltered || (!!id && input.selectedProjectIds!.has(id));
  const inRangeKey = (key: string) => key >= input.range.startKey && key <= input.range.endKey;
  const inRange = (ms: number | null) => ms !== null && inRangeKey(dateKeyOf(ms, tz));
  const rangeDays = (() => {
    const [sy, sm, sd] = input.range.startKey.split('-').map(Number);
    const [ey, em, ed] = input.range.endKey.split('-').map(Number);
    return Math.max(1, Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1);
  })();
  const dayIndex = (ms: number) => {
    const [sy, sm, sd] = input.range.startKey.split('-').map(Number);
    const [y, m, d] = dateKeyOf(ms, tz).split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
  };

  const activities = input.activities.filter((a) => includeAgent(a.agent_id));
  const allTurns = normalizeTurns(activities);
  const isRework = reworkTest(input.activities);
  // A turn belongs to the range by its start, the way the delivery model has
  // always placed runtime; its elapsed share is then cut at local midnights.
  // Runtime is fleet-wide: a turn can touch several projects or none, so a
  // project filter withholds it rather than misattributing it.
  const turns = projectFiltered ? [] : allTurns.filter((t) => inRange(t.start));
  const failures = projectFiltered
    ? []
    : normalizeFailures(activities).filter((f) => inRange(f.at));

  // -- Time accounting ---------------------------------------------------
  const lineOf = (turn: Turn): TimeLine =>
    turn.outcome === 'work' ? (isRework(turn) ? 'rework' : 'work') : turn.outcome;

  const accountingFor = (agentTurns: Turn[], agentFailures: FailedTurn[], dailyInto?: Map<string, LineTotals>): TimeAccounting => {
    const spans: Span[] = agentTurns.map((t) => ({ start: t.start, end: t.end, line: lineOf(t) }));
    // A failed fire's runtime counts once: completed_with_error already has a
    // turn.completed, and an unknown fire has no real finish.
    for (const f of agentFailures) {
      if (f.hasCompletedTurn || f.start === null || f.durationMs === null) continue;
      spans.push({ start: f.start, end: f.start + f.durationMs, line: 'failed' });
    }
    const lines = emptyLines();
    for (const segment of sweep(spans)) {
      for (const slice of daySlices(segment.start, segment.end, tz)) {
        if (!inRangeKey(slice.dateKey)) continue;
        lines[segment.line] += slice.ms;
        if (dailyInto) {
          const day = dailyInto.get(slice.dateKey) ?? emptyLines();
          day[segment.line] += slice.ms;
          dailyInto.set(slice.dateKey, day);
        }
      }
    }
    const activeMs = TIME_LINES.reduce((sum, line) => sum + lines[line], 0);
    const turnCounts = { work: 0, idle: 0, waiting: 0, blocked: 0, skipped: 0, unknown: 0, unlabelled: 0 } as Record<TurnOutcome | 'unlabelled', number>;
    for (const t of agentTurns) turnCounts[t.outcome] += 1;
    return {
      activeMs,
      lines,
      effectiveMs: lines.work,
      productiveShare: activeMs > 0 ? (lines.work + lines.rework) / activeMs : null,
      turns: agentTurns.length,
      turnCounts,
      unknownTurns: turnCounts.unknown,
      unlabelledTurns: turnCounts.unlabelled,
      failedRuns: agentFailures.length,
      failedWithoutTurn: agentFailures.filter((f) => !f.hasCompletedTurn).length,
    };
  };

  const daily = new Map<string, LineTotals>();
  const perAgent = agents
    .filter((m) => includeAgent(m.id))
    .map((m) => ({
      agentId: m.id,
      agentName: m.name,
      accounting: accountingFor(
        turns.filter((t) => t.agentId === m.id),
        failures.filter((f) => f.agentId === m.id),
        daily,
      ),
    }));
  // Each agent's elapsed time is its own; the fleet total is their sum (two
  // agents running at once is two agents' worth of runtime).
  const fleet: TimeAccounting = perAgent.reduce<TimeAccounting>((acc, row) => {
    const a = row.accounting;
    acc.activeMs += a.activeMs;
    for (const line of TIME_LINES) acc.lines[line] += a.lines[line];
    acc.effectiveMs += a.effectiveMs;
    acc.turns += a.turns;
    for (const key of Object.keys(acc.turnCounts) as (keyof typeof acc.turnCounts)[]) acc.turnCounts[key] += a.turnCounts[key];
    acc.unknownTurns += a.unknownTurns;
    acc.unlabelledTurns += a.unlabelledTurns;
    acc.failedRuns += a.failedRuns;
    acc.failedWithoutTurn += a.failedWithoutTurn;
    return acc;
  }, {
    activeMs: 0, lines: emptyLines(), effectiveMs: 0, productiveShare: null, turns: 0,
    turnCounts: { work: 0, idle: 0, waiting: 0, blocked: 0, skipped: 0, unknown: 0, unlabelled: 0 },
    unknownTurns: 0, unlabelledTurns: 0, failedRuns: 0, failedWithoutTurn: 0,
  });
  fleet.productiveShare = fleet.activeMs > 0 ? (fleet.lines.work + fleet.lines.rework) / fleet.activeMs : null;

  const breakdown = (keyOf: (t: Turn) => { key: string; label: string }): BreakdownRow[] => {
    const rows = new Map<string, BreakdownRow>();
    for (const t of turns) {
      const { key, label } = keyOf(t);
      const row = rows.get(key) ?? {
        key, label, activeMs: 0, workMs: 0, idleMs: 0, waitingMs: 0, blockedMs: 0, skippedMs: 0, otherMs: 0, turns: 0, productiveShare: null,
      };
      // Only the part of the turn inside the range, as Time accounting counts it.
      let ms = 0;
      for (const slice of daySlices(t.start, t.end, tz)) if (inRangeKey(slice.dateKey)) ms += slice.ms;
      row.activeMs += ms;
      row.turns += 1;
      if (t.outcome === 'work') row.workMs += ms;
      else if (t.outcome === 'idle') row.idleMs += ms;
      else if (t.outcome === 'waiting') row.waitingMs += ms;
      else if (t.outcome === 'blocked') row.blockedMs += ms;
      else if (t.outcome === 'skipped') row.skippedMs += ms;
      else row.otherMs += ms;
      rows.set(key, row);
    }
    return [...rows.values()]
      .map((row) => ({ ...row, productiveShare: row.activeMs > 0 ? row.workMs / row.activeMs : null }))
      .sort((a, b) => b.activeMs - a.activeMs);
  };
  const byJob = breakdown((t) => t.origin === 'directed'
    ? { key: 'directed', label: 'Directed (Telegram)' }
    : { key: `job:${t.jobName ?? ''}`, label: t.jobName ?? 'Job not recorded' });
  const TRIGGER_LABELS: Record<TurnTrigger, string> = {
    schedule: 'Scheduled tick',
    direct: 'Dispatcher wake',
    telegram: 'Directed (Telegram)',
    unrecorded: 'Trigger not recorded',
  };
  const byTrigger = breakdown((t) => ({ key: t.trigger, label: TRIGGER_LABELS[t.trigger] }));
  const byAgent = breakdown((t) => ({ key: t.agentId, label: nameOf.get(t.agentId) ?? 'Unknown agent' }));

  // -- Tokens ------------------------------------------------------------
  // Scheduled turns carry their own tokens. Directed turns take the usage
  // deltas of their session recorded inside [start, finish + 3 min] (deltas
  // publish 90 s after a session goes quiet). Each delta attributes once.
  const usageBySession = new Map<string, { id: string; at: number; tokens: number; used: boolean }[]>();
  for (const a of activities) {
    if (a.activity_type !== 'usage.recorded') continue;
    const m = a.metadata ?? {};
    const session = str(m.session_id);
    const at = time(m.recorded_at) ?? Date.parse(a.created_at);
    if (!session || !Number.isFinite(at)) continue;
    const list = usageBySession.get(`${a.agent_id}:${session}`) ?? [];
    list.push({ id: a.id, at, tokens: num(m.input_tokens) + num(m.output_tokens) + num(m.cached_tokens), used: false });
    usageBySession.set(`${a.agent_id}:${session}`, list);
  }
  const ATTRIBUTION_GRACE_MS = 3 * 60_000;
  const tokensByOutcome = new Map<TurnOutcome | 'unlabelled', TokenSlice>();
  for (const t of turns.slice().sort((a, b) => a.start - b.start)) {
    let tokens: number | null = null;
    if (t.turnTokens !== null) tokens = t.turnTokens;
    else if (t.origin === 'directed' && t.sessionId) {
      const deltas = usageBySession.get(`${t.agentId}:${t.sessionId}`) ?? [];
      let sum = 0;
      let matched = false;
      for (const delta of deltas) {
        if (delta.used || delta.at < t.start || delta.at > t.end + ATTRIBUTION_GRACE_MS) continue;
        delta.used = true;
        matched = true;
        sum += delta.tokens;
      }
      if (matched) tokens = sum;
    }
    if (tokens === null) continue;
    const slice = tokensByOutcome.get(t.outcome) ?? { outcome: t.outcome, tokens: 0, turns: 0 };
    slice.tokens += tokens;
    slice.turns += 1;
    tokensByOutcome.set(t.outcome, slice);
  }
  const byOutcome = [...tokensByOutcome.values()].sort((a, b) => b.tokens - a.tokens);
  const attributedTokens = byOutcome.reduce((sum, s) => sum + s.tokens, 0);
  const idleTokens = byOutcome
    .filter((s) => s.outcome === 'idle' || s.outcome === 'waiting' || s.outcome === 'skipped')
    .reduce((sum, s) => sum + s.tokens, 0);

  const accepted = new Map<string, number>();
  for (const s of input.suggestions ?? []) {
    if (s.status !== 'approved' || !includeAgent(s.proposed_by) || !includeProject(s.project_id)) continue;
    const at = time(s.reviewed_at) ?? time(s.updated_at);
    if (!inRange(at)) continue;
    accepted.set(s.proposed_by, (accepted.get(s.proposed_by) ?? 0) + 1);
  }
  const tasksWorked = new Map<string, Set<string>>();
  for (const a of activities) {
    if (!isAgentEventType(a.activity_type) || EVENT_STATE[a.activity_type] !== 'work') continue;
    if (!includeProject(a.project_id) || !inRange(Date.parse(a.created_at))) continue;
    const taskId = str(a.metadata?.task_id) ?? a.reference_id;
    if (!taskId) continue;
    const set = tasksWorked.get(a.agent_id) ?? new Set<string>();
    set.add(taskId);
    tasksWorked.set(a.agent_id, set);
  }
  const ratio = (tokens: number | null | undefined, count: number) => (tokens != null && count > 0 ? tokens / count : null);
  const ledgerTotalKnown = perAgent.some((row) => input.ledgerTokensByAgent?.get(row.agentId) != null);
  const tokens: TokenView = {
    ledgerTokens: ledgerTotalKnown
      ? perAgent.reduce((sum, row) => sum + (input.ledgerTokensByAgent?.get(row.agentId) ?? 0), 0)
      : null,
    attributedTokens,
    byOutcome,
    idleShare: attributedTokens > 0 ? idleTokens / attributedTokens : null,
    perAgent: perAgent.map(({ agentId, agentName }) => {
      const ledger = input.ledgerTokensByAgent?.get(agentId) ?? null;
      const merged = input.mergedPrsByAgent?.get(agentId) ?? 0;
      const acceptedCount = accepted.get(agentId) ?? 0;
      const taskCount = tasksWorked.get(agentId)?.size ?? 0;
      return {
        agentId,
        agentName,
        ledgerTokens: ledger,
        mergedPrs: merged,
        acceptedSuggestions: acceptedCount,
        tasksWorked: taskCount,
        perMergedPr: ratio(ledger, merged),
        perAcceptedSuggestion: ratio(ledger, acceptedCount),
        perTask: ratio(ledger, taskCount),
      };
    }),
  };

  // -- Attention ---------------------------------------------------------
  const attentionRows = new Map<string, AttentionRow>();
  const blockingByTask = new Map<string, number>();
  let attentionSeen = false;
  const fleetRows: AgentActivity[] = input.selectedAgentIds?.size
    ? []
    : (input.fleetActivities ?? []).map((a) => ({ ...a, agent_id: null as unknown as string }));
  for (const a of [...activities, ...fleetRows]) {
    if (a.activity_type !== 'attention.message') continue;
    attentionSeen = true;
    const m = a.metadata ?? {};
    const at = time(m.at) ?? Date.parse(a.created_at);
    if (!inRange(at) || !includeProject(a.project_id)) continue;
    const owner = a.agent_id ?? null;
    const key = owner ?? 'fleet';
    const row: AttentionRow = attentionRows.get(key) ?? {
      agentId: owner,
      name: owner ? (nameOf.get(owner) ?? 'Unknown agent') : 'Fleet',
      total: 0, solicited: 0, unsolicited: 0, byKind: {},
      dailyUnsolicited: new Array(rangeDays).fill(0),
    };
    row.total += 1;
    const kind = str(m.kind) ?? 'unknown';
    row.byKind[kind] = (row.byKind[kind] ?? 0) + 1;
    if (m.solicited === true) row.solicited += 1;
    else {
      row.unsolicited += 1;
      const i = dayIndex(at);
      if (i >= 0 && i < rangeDays) row.dailyUnsolicited[i] += 1;
    }
    attentionRows.set(key, row);
    if (kind === 'blocking_question') {
      const taskId = str(m.task_id);
      if (taskId) blockingByTask.set(taskId, (blockingByTask.get(taskId) ?? 0) + 1);
    }
  }
  const attentionList = [...attentionRows.values()].sort((a, b) => (a.agentId === null ? 1 : b.agentId === null ? -1 : b.total - a.total));
  const attentionTotal = attentionList.reduce((sum, row) => sum + row.total, 0);
  const hostAlerts = attentionList.reduce((sum, row) => sum + (row.byKind.host_alert ?? 0), 0);

  // Blocked to resumed: from a `blocked` event on a task to that agent's next
  // sign of progress on it (billing.resumed or any work event).
  const progressByAgentTask = new Map<string, number[]>();
  for (const a of input.activities) {
    const taskId = str(a.metadata?.task_id) ?? a.reference_id;
    if (!taskId) continue;
    const progress = a.activity_type === 'billing.resumed'
      || (isAgentEventType(a.activity_type) && EVENT_STATE[a.activity_type] === 'work' && !a.activity_type.startsWith('billing.'));
    if (!progress) continue;
    const key = `${a.agent_id}:${taskId}`;
    const list = progressByAgentTask.get(key) ?? [];
    list.push(Date.parse(a.created_at));
    progressByAgentTask.set(key, list);
  }
  for (const list of progressByAgentTask.values()) list.sort((x, y) => x - y);
  const resumeWaits: number[] = [];
  let unresolved = 0;
  for (const a of activities) {
    if (a.activity_type !== 'blocked' || !includeProject(a.project_id)) continue;
    const at = Date.parse(a.created_at);
    if (!inRange(at)) continue;
    const taskId = str(a.metadata?.task_id) ?? a.reference_id;
    if (!taskId) continue;
    const next = (progressByAgentTask.get(`${a.agent_id}:${taskId}`) ?? []).find((t) => t > at);
    if (next === undefined) unresolved += 1;
    else resumeWaits.push(next - at);
  }

  const attention: Attention = {
    rows: attentionList,
    total: attentionTotal,
    hostAlertShare: attentionTotal > 0 ? hostAlerts / attentionTotal : null,
    blockingByTask: [...blockingByTask.entries()].map(([taskId, count]) => ({ taskId, count })).sort((a, b) => b.count - a.count),
    blockedToResume: {
      samples: resumeWaits.length,
      medianMs: percentile(resumeWaits, 0.5),
      p95Ms: percentile(resumeWaits, 0.95),
      unresolved,
    },
    tracked: attentionSeen || (input.fleetActivities ?? []).length > 0,
  };

  // -- Quality -----------------------------------------------------------
  // First pass: an approval at round 1 means no changes-requested round came
  // before it in that review cycle. Verdicts are John's, so quality is
  // fleet-wide and follows only the project filter.
  const verdicts = input.activities.filter((a) =>
    a.activity_type === 'review.verdict' && includeProject(a.project_id) && inRange(Date.parse(a.created_at)));
  // Rounds restart at 1 for a replacement PR, so round 1 alone is not first
  // pass: an earlier changes-requested verdict on the task (in any loaded
  // data) means it was not approved first time.
  const changesAt = new Map<string, number[]>();
  for (const a of input.activities) {
    if (a.activity_type !== 'review.verdict' || a.metadata?.verdict !== 'changes_requested') continue;
    const taskId = str(a.metadata?.task_id) ?? a.reference_id;
    if (!taskId) continue;
    const list = changesAt.get(taskId) ?? [];
    list.push(Date.parse(a.created_at));
    changesAt.set(taskId, list);
  }
  const approvalByTask = new Map<string, { round: number; at: number }>();
  const roundKeys = new Set<string>();
  const reviewedTasks = new Set<string>();
  for (const v of verdicts) {
    const m = v.metadata ?? {};
    const taskId = str(m.task_id) ?? v.reference_id ?? v.id;
    reviewedTasks.add(taskId);
    // A round is one verdict on one PR; the PR keeps replacement cycles apart.
    roundKeys.add(`${taskId}:${str(m.pr_url) ?? ''}:${num(m.round)}`);
    if (m.verdict === 'approved') approvalByTask.set(taskId, { round: num(m.round), at: Date.parse(v.created_at) });
  }
  const approvals = approvalByTask.size;
  const firstPass = [...approvalByTask.entries()].filter(([taskId, approval]) =>
    approval.round === 1 && !(changesAt.get(taskId) ?? []).some((at) => at < approval.at)).length;

  const merges = input.activities.filter((a) => a.activity_type === 'pr.merged');
  const titled = merges.filter((a) => str(a.metadata?.title));
  const mergedInRange = new Map<string, AgentActivity>();
  for (const a of merges) {
    const pr = normalizePullRequestUrl(a.metadata?.pr_url);
    if (pr && includeProject(a.project_id) && inRange(Date.parse(a.created_at)) && !mergedInRange.has(pr)) mergedInRange.set(pr, a);
  }
  // A revert is a later merged PR titled `Revert "<original title>"` in the
  // same repository: GitHub's own revert button writes exactly that.
  const revertedPrs: { prUrl: string; revertUrl: string }[] = [];
  if (titled.length > 0) {
    const repoOf = (url: string | null) => url?.split('/pull/')[0] ?? null;
    for (const [pr, original] of mergedInRange) {
      const title = str(original.metadata?.title);
      if (!title) continue;
      const revert = titled.find((a) => {
        const revertPr = normalizePullRequestUrl(a.metadata?.pr_url);
        return revertPr !== pr && repoOf(revertPr) === repoOf(pr)
          && Date.parse(a.created_at) > Date.parse(original.created_at)
          && str(a.metadata?.title) === `Revert "${title}"`;
      });
      if (revert) revertedPrs.push({ prUrl: String(original.metadata?.pr_url), revertUrl: String(revert.metadata?.pr_url) });
    }
  }
  // Reopens exist only from when the recorder was installed: a range that
  // ends before then has nothing measured, which is not the same as zero.
  const trackingSince = time(input.reopenTrackingSince ?? null);
  const reopensMeasurable = input.reopens != null && trackingSince !== null
    && dateKeyOf(trackingSince, tz) <= input.range.endKey;
  const reopensInRange = !reopensMeasurable
    ? null
    : input.reopens!.filter((r) => includeProject(r.project_id) && inRange(time(r.reopened_at))).length;
  const quality: Quality = {
    approvals,
    firstPass,
    firstPassRate: approvals > 0 ? firstPass / approvals : null,
    reviewRounds: roundKeys.size,
    tasksReviewed: reviewedTasks.size,
    roundsPerTask: reviewedTasks.size > 0 ? roundKeys.size / reviewedTasks.size : null,
    reopened: reopensInRange,
    reopenedSince: input.reopenTrackingSince ?? null,
    mergedPrs: mergedInRange.size,
    revertedAtLeast: revertedPrs.length > 0 ? revertedPrs.length : null,
    revertTitlesReported: titled.length > 0,
    revertedPrs,
  };

  // -- Reliability -------------------------------------------------------
  const runsByJob = new Map<string, { agentId: string; jobName: string; runs: number; failures: number }>();
  const jobKey = (agentId: string, job: string | null) => `${agentId}:${job ?? ''}`;
  for (const t of turns) {
    if (t.origin !== 'scheduled') continue;
    const key = jobKey(t.agentId, t.jobName);
    const row = runsByJob.get(key) ?? { agentId: t.agentId, jobName: t.jobName ?? 'Job not recorded', runs: 0, failures: 0 };
    row.runs += 1;
    runsByJob.set(key, row);
  }
  for (const f of failures) {
    const key = jobKey(f.agentId, f.jobName);
    const row = runsByJob.get(key) ?? { agentId: f.agentId, jobName: f.jobName ?? 'Job not recorded', runs: 0, failures: 0 };
    row.failures += 1;
    // A completed_with_error fire is already one of the runs; any other
    // failure is a fire that never completed, so it is a run of its own.
    if (!f.hasCompletedTurn) row.runs += 1;
    runsByJob.set(key, row);
  }
  const failureRates = [...runsByJob.values()]
    .filter((row) => row.failures > 0)
    .map((row) => ({ ...row, agentName: nameOf.get(row.agentId) ?? 'Unknown agent', rate: row.runs > 0 ? row.failures / row.runs : 0 }))
    .sort((a, b) => b.rate - a.rate || b.failures - a.failures);

  const restarts: Reliability['restarts'] = [];
  const wakes = { stateChange: 0, continuation: 0, yielded: 0 };
  const waited: number[] = [];
  let sawRestart = false;
  let sawWake = false;
  for (const a of activities) {
    const m = a.metadata ?? {};
    if (a.activity_type === 'agent.restarted') {
      sawRestart = true;
      const at = time(m.started_at);
      if (!inRange(at)) continue;
      restarts.push({ id: a.id, agentId: a.agent_id, agentName: nameOf.get(a.agent_id) ?? 'Unknown agent', kind: str(m.kind) ?? 'container', at: at!, deployCommit: str(m.deploy_commit) });
    } else if (a.activity_type === 'dispatch.wake') {
      sawWake = true;
      const at = time(m.at);
      if (!inRange(at)) continue;
      if (m.kind === 'state_change') {
        wakes.stateChange += 1;
        if (typeof m.waited_seconds === 'number') waited.push(m.waited_seconds);
      } else if (m.kind === 'continuation') wakes.continuation += 1;
      else if (m.kind === 'yielded') wakes.yielded += 1;
    }
  }
  restarts.sort((a, b) => b.at - a.at);

  // Overlap: two turns of one agent whose time ranges intersect, scheduled or
  // directed. On Oct 4 this was a real billing bug, so every pair is listed.
  const overlaps: Reliability['overlaps'] = [];
  for (const { agentId, agentName } of perAgent) {
    const mine = turns.filter((t) => t.agentId === agentId && t.end > t.start).sort((a, b) => a.start - b.start);
    const pairs: { first: Turn; second: Turn; overlapMs: number }[] = [];
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length && mine[j].start < mine[i].end; j++) {
        pairs.push({ first: mine[i], second: mine[j], overlapMs: Math.min(mine[i].end, mine[j].end) - mine[j].start });
      }
    }
    if (pairs.length === 0) continue;
    // Elapsed overlap: time covered by two or more turns at once, counted once.
    const doubled = sweepDepth(mine.map((t) => [t.start, t.end] as [number, number]));
    overlaps.push({
      agentId,
      agentName,
      pairs: pairs.length,
      overlapMs: doubled,
      examples: pairs.sort((a, b) => b.overlapMs - a.overlapMs).slice(0, 10),
    });
  }

  const reliability: Reliability = {
    failures: failures.slice().sort((a, b) => b.at - a.at),
    failureRates,
    restarts,
    overlaps,
    handoff: { samples: waited.length, p50Seconds: percentile(waited, 0.5), p95Seconds: percentile(waited, 0.95) },
    wakes,
    tracked: {
      failures: activities.some((a) => a.activity_type === 'turn.failed'),
      restarts: sawRestart,
      wakes: sawWake,
    },
  };

  // -- Billing gaps ------------------------------------------------------
  const reviews = new Map((input.gapReviews ?? []).map((r) => [r.activity_id, r]));
  const PHASE_ORDER = { mid_turn: 0, unbilled_turn: 1, after_timer: 2, before_timer: 3 } as const;
  // A gap belongs to a turn, which is fleet-wide, so a project filter
  // withholds gaps the way it withholds runtime.
  const billingGaps: BillingGap[] = (projectFiltered ? [] : activities)
    .filter((a) => a.activity_type === 'billing.gap')
    .map((a) => {
      const m = a.metadata ?? {};
      return {
        id: a.id,
        agentId: a.agent_id,
        start: time(m.start) ?? Date.parse(a.created_at),
        end: time(m.end) ?? Date.parse(a.created_at),
        minutes: num(m.minutes),
        phase: (m.phase in PHASE_ORDER ? m.phase : 'unbilled_turn') as BillingGap['phase'],
        origin: str(m.origin),
        sourceTurnId: str(m.source_turn_id) ?? '',
        taskId: str(m.task_id),
        review: reviews.get(a.id) ?? null,
      };
    })
    .filter((gap) => inRange(gap.start))
    // Open before reviewed, mid-turn first (the timer paused while work went
    // on), then the newest.
    .sort((a, b) => Number(Boolean(a.review)) - Number(Boolean(b.review))
      || PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
      || b.start - a.start);

  // -- Models and evals --------------------------------------------------
  const models = perAgent.map(({ agentId, agentName }) => {
    const runs: ModelRun[] = [];
    for (const t of turns.filter((x) => x.agentId === agentId && x.model).sort((a, b) => a.start - b.start)) {
      const last = runs[runs.length - 1];
      if (last && last.model === t.model) {
        last.to = Math.max(last.to, t.end);
        last.turns += 1;
      } else runs.push({ model: t.model!, from: t.start, to: t.end, turns: 1 });
    }
    return { agentId, agentName, runs };
  }).filter((row) => row.runs.length > 0);

  const evalsBySuite = new Map<string, EvalPoint[]>();
  for (const a of activities) {
    if (a.activity_type !== 'eval.result') continue;
    const m = a.metadata ?? {};
    const at = time(m.started_at) ?? Date.parse(a.created_at);
    if (!inRange(at)) continue;
    const suite = str(m.suite) ?? 'unknown';
    const total = num(m.total);
    const score = num(m.score);
    const list = evalsBySuite.get(suite) ?? [];
    list.push({
      id: a.id,
      suite,
      at,
      score,
      total,
      pct: total > 0 ? score / total : null,
      complete: m.complete === true,
      model: str(m.model),
      failedCases: Array.isArray(m.failed_cases) ? m.failed_cases.filter((c: unknown) => c !== null).map(String) : [],
    });
    evalsBySuite.set(suite, list);
  }
  const evals = [...evalsBySuite.entries()]
    .map(([suite, points]) => ({ suite, points: points.sort((a, b) => a.at - b.at) }))
    .sort((a, b) => a.suite.localeCompare(b.suite));

  return {
    turns,
    fleet,
    perAgent,
    byJob,
    byTrigger,
    byAgent,
    daily: [...daily.entries()].map(([dateKey, lines]) => ({ dateKey, lines })).sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
    tokens,
    attention,
    quality,
    reliability,
    billingGaps,
    models,
    evals,
    outcomesReported: allTurns.some((t) => t.outcome !== 'unlabelled' && t.origin === 'scheduled'),
  };
}

/** Elapsed time covered by at least two of the intervals. */
function sweepDepth(intervals: [number, number][]): number {
  const edges: [number, number][] = [];
  for (const [start, end] of intervals) edges.push([start, 1], [end, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let last = 0;
  let total = 0;
  for (const [at, delta] of edges) {
    if (depth >= 2) total += at - last;
    depth += delta;
    last = at;
  }
  return total;
}
