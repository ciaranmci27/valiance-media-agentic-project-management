import type { AgentActivity, Project, Task, TimeEntry } from '@/lib/types';
import { projectTimeEntryForBilling, type DateRange } from '@/lib/finance/summary';
import { getWorkedHoursByDay } from '@/lib/time-entry-utils';
import { normalizePullRequestUrl } from '@/lib/agent-analytics';
import { dateKeyOf, sweep } from '@/lib/agent-telemetry-analytics';
import { isOpenEventType, isTelemetryEvent } from '@/lib/agent-events';
import { runDurationMs, runPill } from '@/lib/agents-tab';
import type { AgentRunStatus, AgentRunSummary } from '@/lib/agent-runs';

/**
 * The Agents page's Analytics tab, as one pure read model
 * (scripts/verify-agent-analytics.ts checks it).
 *
 * Everything countable becomes a Fact: one kind, one agent, one project (or
 * none), one model (or none), one day, one value. Totals, the chart, the
 * sparklines and every breakdown (agent, project, model, role) are group-bys
 * over the same facts, so overall always equals the sum of any breakdown.
 *
 * Rules it keeps:
 * - Runs are the run feed's rows (pm.agent_run_feed): stored runs, plus each
 *   turn that names no run. Turns are never counted beside the feed; only when
 *   the feed cannot be read are runs derived from turns, with the feed's rule.
 * - Busy time is the union of an agent's run spans: overlapping runs count
 *   once. Each run keeps the part no earlier run already covered, so the
 *   split by project or model adds up to the union.
 * - Tokens and cost come from the server's spend (pm.agent_run_stats's
 *   spend, read from pm.agent_spend_facts, the same count the budget
 *   uses): a run's own totals for work under a run, plus usage and turns
 *   that name no run; usage and turns that name a run never add again. So
 *   no row cap on the event window can make them short. Only on a database
 *   before 20261125000800: an agent that reports a usage ledger
 *   (usage.recorded) is measured from it, any other agent from its runs.
 * - Cost of 0 or missing beside real tokens is "subscription or unpriced",
 *   never a real zero spend.
 * - Money (revenue, profit, margin) shows only when the billing module is on
 *   and an agent in the selection bills (moneyVisibility).
 * - Provider and model are whatever strings arrive; nothing is hard-coded.
 *   A usage record's or run's own provider wins over a "provider/" prefix.
 *   Usage the first analytics window summed per hour carries no model: it
 *   files under "Usage not split by model yet", and its cost reads as priced
 *   or mixed, since one hour can hold both. The second window sums per model,
 *   provider and pricing, so its hours read exactly as the raw records.
 * - A stored run that reports no tokens takes its attached turns' own tokens
 *   (turns naming it by run_id), for agents without a usage ledger. Only runs
 *   still without any count as "runs that report no tokens".
 * - Labels: facts from a labelled event (usage, pull requests, reviews,
 *   blocked, host failures) carry its labels. The label breakdown files a
 *   fact under each of its labels, so its rows can add up to more than the
 *   total; the label filter keeps facts with any picked label.
 * - Runs and questions may arrive pre-summed by the server (pm.agent_run_stats,
 *   pm.agent_question_stats) instead of as rows: the facts are the same.
 * - A provider plan's subscription cost is an estimate, allocated by unpriced
 *   token share, kept apart from measured cost and never added to it.
 * - Revenue is approved time only (approval_status === 'approved', the
 *   Finances rule); the rest is pending.
 */

// ── Facts ───────────────────────────────────────────────────────────────────

export const SUM_KINDS = [
  'run', 'runSucceeded', 'runFailed',
  /** Runs still going (running or waiting): counted in run, never in a success rate. */
  'runRunning',
  'busyMs',
  'tokensIn', 'tokensOut', 'tokensCached', 'costUsd', 'unpricedTokens',
  /** Cost from records the server summed per hour: priced, or priced and unpriced merged. Part of costUsd. */
  'mergedCostUsd',
  /** Stored runs of agents without a usage ledger that reported no tokens (their turns may carry them). */
  'runsNoTokens',
  'taskDone', 'prOpened', 'prMerged', 'review',
  'question', 'approval', 'incident', 'reopen', 'blocked',
  'revenue', 'billableHours', 'pendingRevenue',
] as const;
export type SumKind = (typeof SUM_KINDS)[number];

/** Durations measured per occurrence, read as a median, never summed. */
export const SAMPLE_KINDS = ['answerMs', 'resumeMs'] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export type FactKind = SumKind | SampleKind;

export interface Fact {
  kind: FactKind;
  agentId: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  /** Usage summed per hour by the server, with no model or provider kept. */
  unsplit?: boolean;
  /** The labels of the event the fact came from; absent when it has none. */
  labels?: string[];
  dateKey: string;
  value: number;
}

export type Sums = Record<SumKind, number>;

export interface Group {
  sums: Sums;
  samples: Record<SampleKind, number[]>;
}

const isSample = (kind: FactKind): kind is SampleKind => (SAMPLE_KINDS as readonly string[]).includes(kind);

export function emptyGroup(): Group {
  return {
    sums: Object.fromEntries(SUM_KINDS.map((k) => [k, 0])) as Sums,
    samples: { answerMs: [], resumeMs: [] },
  };
}

function addFact(group: Group, fact: Fact): void {
  if (isSample(fact.kind)) group.samples[fact.kind].push(fact.value);
  else group.sums[fact.kind] += fact.value;
}

export function groupOf(facts: Fact[]): Group {
  const group = emptyGroup();
  for (const fact of facts) addFact(group, fact);
  return group;
}

export function groupBy(facts: Fact[], keyOf: (fact: Fact) => string): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const fact of facts) {
    const key = keyOf(fact);
    let group = out.get(key);
    if (!group) { group = emptyGroup(); out.set(key, group); }
    addFact(group, fact);
  }
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Provider and model ──────────────────────────────────────────────────────

/**
 * The provider a usage record names, else the prefix of a "provider/model"
 * string, else null (not reported). Whatever string arrives is the group.
 */
export function providerOf(model: string | null, provider?: unknown): string | null {
  if (typeof provider === 'string' && provider.trim()) return provider.trim();
  if (!model) return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash).trim() || null : null;
}

const cleanModel = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// ── Cost labelling ──────────────────────────────────────────────────────────

export type CostLabel =
  | { kind: 'priced'; usd: number }
  | { kind: 'mixed'; usd: number }
  | { kind: 'partial'; usd: number; unpricedTokens: number }
  | { kind: 'unpriced'; tokens: number }
  | { kind: 'none' };

/**
 * What a group's cost is. Priced: every token came with a price. Mixed: the
 * cost came from usage the server summed per hour, where one hour can merge
 * priced and unpriced records, so it is priced or mixed and never claimed as
 * fully priced. Partial: some tokens came with a price, some with none.
 * Unpriced: tokens with no price at all (a subscription runs the harness, or
 * the provider sends no cost), never a real $0. None: no tokens and no cost.
 */
export function costLabel(sums: Pick<Sums, 'costUsd' | 'unpricedTokens' | 'mergedCostUsd' | 'tokensIn' | 'tokensOut' | 'tokensCached'>): CostLabel {
  const tokens = sums.tokensIn + sums.tokensOut + sums.tokensCached;
  if (sums.costUsd > 0 && sums.unpricedTokens > 0) return { kind: 'partial', usd: sums.costUsd, unpricedTokens: sums.unpricedTokens };
  if (sums.costUsd > 0 && sums.mergedCostUsd > 0) return { kind: 'mixed', usd: sums.costUsd };
  if (sums.costUsd > 0) return { kind: 'priced', usd: sums.costUsd };
  if (tokens > 0) return { kind: 'unpriced', tokens };
  return { kind: 'none' };
}

export const UNPRICED_LABEL = 'Subscription or unpriced';
export const MIXED_LABEL = 'priced or mixed';

/** The words a cost shows as: a money figure, the unpriced label, or null for nothing. */
export function costText(label: CostLabel, money: (usd: number) => string): string | null {
  switch (label.kind) {
    case 'priced': return money(label.usd);
    case 'mixed': return `${money(label.usd)} ${MIXED_LABEL}`;
    case 'partial': return `${money(label.usd)} + unpriced`;
    case 'unpriced': return UNPRICED_LABEL;
    case 'none': return null;
  }
}

// ── Money visibility ────────────────────────────────────────────────────────

export interface BillingSignal {
  agentId: string;
  /** Approved billable value in the window. */
  billableValue: number;
  /** Billable value in the window still waiting for approval. */
  pendingValue: number;
  /** The agent bills at a rate above zero on client work. */
  hasBillingRate: boolean;
}

export type MoneyVisibility =
  | { show: true; reason: 'billing' }
  | { show: false; reason: 'module_off' | 'no_permission' | 'nothing_billable' };

/**
 * Revenue, profit and margin only mean something when agents bill, and only
 * for someone who may read revenue. They show when the billing module is on,
 * the viewer holds billing.manage or finance.company.read (the server's
 * canReadRevenueInputs), AND at least one agent in the selection has billable
 * work in the window or a billing rate. Otherwise money is hidden entirely:
 * no zero placeholders.
 */
export function moneyVisibility(input: { billingModuleOn: boolean; canReadRevenue: boolean; agents: BillingSignal[] }): MoneyVisibility {
  if (!input.billingModuleOn) return { show: false, reason: 'module_off' };
  if (!input.canReadRevenue) return { show: false, reason: 'no_permission' };
  const bills = input.agents.some((a) => a.billableValue > 0 || a.pendingValue > 0 || a.hasBillingRate);
  return bills ? { show: true, reason: 'billing' } : { show: false, reason: 'nothing_billable' };
}

// ── Metrics and tiles ───────────────────────────────────────────────────────

// Runs lead (the default chart), money after the work it pays for: an
// install whose agents do not bill never opens on an empty revenue chart.
export const METRIC_KEYS = [
  'runs', 'busy', 'tasks', 'prs', 'tokens', 'revenue', 'profit', 'cost', 'questions', 'incidents', 'reopened', 'blocked',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricFormat = 'currency' | 'count' | 'duration' | 'tokens';

export const METRIC_FORMAT: Record<MetricKey, MetricFormat> = {
  revenue: 'currency', profit: 'currency', runs: 'count', busy: 'duration', tasks: 'count', prs: 'count',
  tokens: 'tokens', cost: 'currency', questions: 'count', incidents: 'count', reopened: 'count', blocked: 'count',
};

export const MONEY_METRICS: readonly MetricKey[] = ['revenue', 'profit'];

/** One metric's value for a set of sums: what the tile, chart and ranking show. */
export function metricValue(key: MetricKey, s: Sums): number {
  switch (key) {
    case 'revenue': return s.revenue;
    case 'profit': return s.revenue - s.costUsd;
    case 'runs': return s.run;
    case 'busy': return s.busyMs;
    case 'tasks': return s.taskDone;
    case 'prs': return s.prMerged;
    case 'tokens': return s.tokensIn + s.tokensOut;
    case 'cost': return s.costUsd;
    case 'questions': return s.question + s.approval;
    case 'incidents': return s.incident;
    case 'reopened': return s.reopen;
    case 'blocked': return s.blocked;
  }
}

/** Whether the window holds anything for a metric. Money is decided by moneyVisibility, not here. */
export function metricHasData(key: MetricKey, s: Sums): boolean {
  switch (key) {
    // Money shows by moneyVisibility, but a $0 range is no data: it never opens the chart.
    case 'revenue': return s.revenue > 0 || s.pendingRevenue > 0;
    case 'profit': return s.revenue > 0 || s.costUsd > 0;
    case 'prs': return s.prOpened + s.prMerged + s.review > 0;
    // Cost is never hidden where tokens exist: unpriced tokens still show it.
    case 'cost': return s.costUsd > 0 || s.tokensIn + s.tokensOut + s.tokensCached > 0;
    case 'tokens': return s.tokensIn + s.tokensOut + s.tokensCached > 0;
    default: return metricValue(key, s) > 0;
  }
}

export interface TileState {
  key: MetricKey;
  hasData: boolean;
}

/** Tiles that read the run feed: left out when it failed, never shown short. Profit subtracts run cost, so it goes too. */
export const RUN_METRICS: readonly MetricKey[] = ['runs', 'busy', 'tokens', 'cost', 'incidents', 'profit'];

/** Every tile the view may show, in order. Money tiles only when money shows; run tiles only when runs were read. */
export function tileStates(totals: Sums, money: MoneyVisibility, runsAvailable = true): TileState[] {
  return METRIC_KEYS
    .filter((key) => money.show || !MONEY_METRICS.includes(key))
    .filter((key) => runsAvailable || !RUN_METRICS.includes(key))
    .map((key) => ({ key, hasData: metricHasData(key, totals) }));
}

export const DEFAULT_TILE_CAP = 8;

/**
 * Which tiles show. Collapsed: the ones with data in the window, at most
 * `cap`, in order. Expanded ("More stats"): every tile. `more` counts what the
 * control would add.
 */
export function arrangeTiles(tiles: TileState[], options: { expanded: boolean; cap?: number }): { shown: MetricKey[]; more: number } {
  const cap = options.cap ?? DEFAULT_TILE_CAP;
  const shown = options.expanded ? tiles.map((t) => t.key) : tiles.filter((t) => t.hasData).slice(0, cap).map((t) => t.key);
  return { shown, more: tiles.length - shown.length };
}

/**
 * The tile that drives the chart: the one picked while it shows, else the
 * first shown with data (never an empty $0 chart), else the first shown.
 * `withData` lists the tiles that hold anything; left out, every shown tile counts.
 */
export function resolveSelectedMetric(shown: MetricKey[], selected: MetricKey | null, withData?: readonly MetricKey[]): MetricKey | null {
  if (selected && shown.includes(selected)) return selected;
  return shown.find((key) => !withData || withData.includes(key)) ?? shown[0] ?? null;
}

// ── Change against the last period ──────────────────────────────────────────

/** The same number of days just before the range: what "change" compares with. */
export function previousRange(range: DateRange): DateRange {
  const days = rangeDays(range).length;
  const [y, m, d] = range.startKey.split('-').map(Number);
  const key = (t: number) => new Date(t).toISOString().slice(0, 10);
  const start = Date.UTC(y, m - 1, d);
  return { startKey: key(start - days * 86_400_000), endKey: key(start - 86_400_000) };
}

/**
 * The tiles whose last period can be measured as completely as this one: the
 * server's run and question sums cover any range, the event window does not.
 * Tokens and cost only with the server's spend; in the demo only what the
 * run feed holds.
 */
export function changeMetrics(source: { runStats: boolean; spend: boolean; questionStats: boolean; feedRows: boolean }): MetricKey[] {
  const out: MetricKey[] = [];
  if (source.runStats || source.feedRows) out.push('runs', 'busy');
  if (source.runStats && source.spend) out.push('tokens', 'cost');
  if (source.questionStats) out.push('questions');
  return out;
}

/** Up or down is good or bad only where it has a clear meaning: spend going up is bad. */
const CHANGE_GOOD: Partial<Record<MetricKey, 'up' | 'down'>> = { cost: 'down', incidents: 'down', reopened: 'down', blocked: 'down' };

export interface PeriodChange {
  /** "12%". */
  value: string;
  direction: 'up' | 'down' | 'flat';
  good?: 'up' | 'down';
}

/** This period against the last, as a share; null when the last period had none (no share to give). */
export function periodChange(key: MetricKey, current: number, previous: number): PeriodChange | null {
  if (previous === 0) return null;
  const good = CHANGE_GOOD[key];
  const share = (current - previous) / Math.abs(previous);
  const pct = Math.round(Math.abs(share) * 100);
  if (pct === 0) return { value: '0%', direction: 'flat' };
  return { value: `${pct}%`, direction: share > 0 ? 'up' : 'down', good };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** One pm.agent_run_feed row, as far as analytics reads it. */
export interface RunRow {
  /** The run's id, for its attached turns' tokens. Absent on rows built without one. */
  id?: string;
  source: 'run' | 'turn';
  agentId: string;
  projectId: string | null;
  status: AgentRunStatus;
  outcome: string | null;
  title: string | null;
  model: string | null;
  /** The provider the run named (agent_runs.provider); absent when not read. */
  provider?: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/**
 * pm.agent_run_stats: the run feed summed per agent, project, model, provider
 * and day by the server, with the read model's own rules (busy time already
 * the union of each agent's spans; attached turns' tokens already filled in).
 * failures lists every failed run read, for incidents.
 */
export interface RunStatGroup {
  agentId: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  dateKey: string;
  runs: number;
  succeeded: number;
  failed: number;
  /** Runs still going (running or waiting); undefined from a database before 20261127001500. */
  running?: number;
  busyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  unpricedTokens: number;
  runsNoTokens: number;
}

export interface RunFailure {
  agentId: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  startedAt: string;
  title: string | null;
  status: string;
}

/**
 * pm.agent_run_stats's spend: pm.agent_spend_facts (the budget's own count)
 * summed per agent, project, model, provider, day, labels and person. Cost
 * is the priced part (above 0); unpricedTokens are the tokens that came with
 * none. principalId is who the work was for (null: the agent as itself).
 */
export interface SpendGroup {
  agentId: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  dateKey: string;
  labels: string[];
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  unpricedTokens: number;
  /** Who the work was for (X-Act-For or a personal agent's person); null when the agent worked as itself or the database predates it. */
  principalId?: string | null;
}

export interface RunStats {
  groups: RunStatGroup[];
  failures: RunFailure[];
  /** Absent on a database before 20261125000800: tokens and cost then come from usage and runs as before. */
  spend?: SpendGroup[];
}

/** pm.agent_question_stats: questions per asker, project and day, with every answer time. */
export interface QuestionStatGroup {
  askedBy: string;
  projectId: string | null;
  dateKey: string;
  questions: number;
  approvals: number;
  /** Each answered question's time to answer, in milliseconds. */
  answerMs: number[];
  medianAnswerMs: number | null;
}

export interface QuestionStats {
  /** all: every question (an Owner or agents.manage); projects: projects the viewer can open, and their own. */
  scope: 'all' | 'projects';
  groups: QuestionStatGroup[];
}

/** A provider subscription (pm.provider_plans): cost per seat per month. */
export interface ProviderPlan {
  provider: string;
  monthlyCostUsd: number;
  seats: number;
}

export interface SubscriptionEstimate {
  /** Every plan's monthly cost (cost per seat x seats). */
  monthlyUsd: number;
  /** The share of the range's subscription cost the selection's unpriced tokens take. An estimate. */
  estimateUsd: number;
  providers: string[];
}

export const SUBSCRIPTION_LABEL = 'Subscription cost';
export const ESTIMATE_LABEL = 'estimate by token share, not in model cost';

export interface QuestionRow {
  askedBy: string;
  projectId: string | null;
  kind: 'question' | 'approval';
  createdAt: string;
  answeredAt: string | null;
}

export interface ReopenRow {
  taskId: string;
  projectId: string | null;
  reopenedAt: string;
}

export interface AnalyticsAgent {
  id: string;
  name: string;
  role: string | null;
}

export interface AgentAnalyticsInput {
  range: DateRange;
  timezone?: string;
  now: number;
  agents: AnalyticsAgent[];
  projects: Pick<Project, 'id' | 'hourly_tracking' | 'hourly_rate'>[];
  runs: RunRow[];
  /** Agent events in the window (usage, PRs, reviews, blocked, host failure records). */
  activities: AgentActivity[];
  questions: QuestionRow[];
  tasks: Pick<Task, 'id' | 'project_id' | 'completed_at' | 'claimed_by' | 'assignee_ids'>[];
  /** null when reopen tracking cannot be read. */
  reopens: ReopenRow[] | null;
  timeEntries: TimeEntry[];
  billingModuleOn: boolean;
  /** The viewer holds billing.manage or finance.company.read. */
  canReadRevenue: boolean;
  /** False when the run feed failed to load: run figures are left out, not shown short. */
  runsAvailable?: boolean;
  /** The server's run sums (pm.agent_run_stats); when set, `runs` is not read. Busy time under a project filter must come from a call with that filter. */
  runStats?: RunStats | null;
  /** The server's question sums (pm.agent_question_stats); when set, `questions` is not read. */
  questionStats?: QuestionStats | null;
  /** Provider subscriptions, for the estimate beside measured cost. */
  providerPlans?: ProviderPlan[];
  selectedAgentIds?: ReadonlySet<string>;
  selectedProjectIds?: ReadonlySet<string>;
  /** Facts with any of these labels; facts with none leave. */
  selectedLabels?: ReadonlySet<string>;
}

export interface AgentAnalyticsModel {
  /** Facts inside the selection. */
  facts: Fact[];
  totals: Group;
  money: MoneyVisibility;
  tiles: TileState[];
  /** Agents measured from a usage ledger rather than their runs. */
  ledgerAgents: Set<string>;
  /** Usage a project filter left out because it names no project: profit and margin exclude it. */
  excludedNoProject: Pick<Sums, 'costUsd' | 'unpricedTokens'>;
  runsAvailable: boolean;
  /** Provider plans' subscription cost, as an estimate; null without plans. Never part of totals. */
  subscription: SubscriptionEstimate | null;
}

/**
 * What profit leaves out under a project filter (or on a project row): usage
 * with no project, which cannot be assigned. Priced usage names its amount;
 * unpriced usage is "not assignable". Null when nothing is left out.
 */
export function profitCaveat(excluded: Pick<Sums, 'costUsd' | 'unpricedTokens'>, money: (usd: number) => string): string | null {
  if (excluded.costUsd > 0) {
    return `Excludes ${money(excluded.costUsd)} usage with no project${excluded.unpricedTokens > 0 ? ', plus unpriced usage not assignable' : ''}`;
  }
  if (excluded.unpricedTokens > 0) return 'Unpriced usage with no project not assignable';
  return null;
}

export interface ViewerScope {
  projectsReadAll: boolean;
  timeReadAll: boolean;
  /** Where questions came from the server's sums, the rule it applied; absent for rows read under row access. */
  questionsScope?: QuestionStats['scope'] | null;
}

export const SCOPE_QUESTIONS = 'Only questions you can open';
export const SCOPE_QUESTIONS_PROJECTS = 'Questions on projects you can open, and your own';
export const SCOPE_TASKS = 'Only tasks you can open';
export const SCOPE_TIME = 'Only time you can see';

/**
 * Where a figure can only count what the viewer's row access lets them read.
 * Questions read as rows always (their row policy hides questions between
 * other people); from the server's sums, only for a viewer who does not
 * oversee every agent (questions on no project between others stay out);
 * tasks without projects.read_all; revenue without time.read_all.
 */
export function scopeNotes(scope: ViewerScope): { questions: string | null; tasks: string | null; revenue: string | null } {
  return {
    questions: scope.questionsScope === 'all' ? null : scope.questionsScope === 'projects' ? SCOPE_QUESTIONS_PROJECTS : SCOPE_QUESTIONS,
    tasks: scope.projectsReadAll ? null : SCOPE_TASKS,
    revenue: scope.timeReadAll ? null : SCOPE_TIME,
  };
}

// ── Runs from turns (fallback only) ─────────────────────────────────────────

/** Scheduled turns that found nothing to do: never a run in the feed. */
const QUIET_SCHEDULED = new Set(['idle', 'skipped', 'waiting']);

/**
 * The run feed's turn rows, built from turn.completed events, with the
 * feed's own rule: a turn is a run when it names no run, unless it is a
 * scheduled check that found nothing to do. Used only when the feed cannot be
 * read; never added to feed rows.
 */
export function runsFromTurns(activities: AgentActivity[]): RunRow[] {
  const seen = new Set<string>();
  const out: RunRow[] = [];
  for (const a of activities) {
    if (a.activity_type !== 'turn.completed' || !a.agent_id) continue;
    const m = a.metadata ?? {};
    if (typeof m.run_id === 'string' && m.run_id) continue;
    const outcome = typeof m.outcome === 'string' ? m.outcome : null;
    if (m.origin === 'scheduled' && outcome && QUIET_SCHEDULED.has(outcome)) continue;
    const key = `${a.agent_id}:${typeof m.source_turn_id === 'string' ? m.source_turn_id : a.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tokens = m.tokens_scope === 'turn' && m.tokens && typeof m.tokens === 'object' ? m.tokens as Record<string, unknown> : null;
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    out.push({
      source: 'turn',
      agentId: a.agent_id,
      projectId: a.project_id ?? null,
      status: 'succeeded',
      outcome,
      title: a.title || null,
      model: cleanModel(m.model),
      startedAt: typeof m.started_at === 'string' ? m.started_at : a.created_at,
      finishedAt: typeof m.finished_at === 'string' ? m.finished_at : null,
      durationMs: count(m.duration_ms),
      tokensIn: tokens ? count(tokens.input) : null,
      tokensOut: tokens ? count(tokens.output) : null,
      costUsd: null,
    });
  }
  return out;
}

/** One row of the run feed (what Agents > Runs lists) as analytics reads it. */
export function runRowFromFeed(row: Pick<AgentRunSummary, 'id' | 'source' | 'agent_id' | 'project_id' | 'status' | 'outcome' | 'title' | 'model' | 'started_at' | 'finished_at' | 'duration_ms' | 'tokens_in' | 'tokens_out' | 'cost_usd'>): RunRow {
  return {
    id: row.id,
    source: row.source,
    agentId: row.agent_id,
    projectId: row.project_id,
    status: row.status,
    outcome: row.outcome,
    title: row.title,
    model: row.model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
  };
}

/**
 * The runs analytics counts, so its Runs figure is the Runs list's count for
 * the same range and filters: none when the read failed or the server summed
 * them already; the run feed's rows when there are some (the database's, or
 * the demo's own feed); turns only where no feed exists, by the feed's rule.
 */
export function analyticsRunRows(input: { runsFailed: boolean; serverSummed: boolean; feedRows: RunRow[] | null; activities: AgentActivity[] }): RunRow[] {
  if (input.runsFailed || input.serverSummed) return [];
  return input.feedRows ?? runsFromTurns(input.activities);
}

/**
 * Agents > Runs for exactly what the report shows, or null when the Runs list
 * cannot filter to it (more than one agent or project, or a label picked), so
 * a link never promises runs it would not list.
 */
export function runsListHref(range: DateRange, selection: { agentIds: ReadonlySet<string>; projectIds: ReadonlySet<string>; labels: ReadonlySet<string> }): string | null {
  if (selection.agentIds.size > 1 || selection.projectIds.size > 1 || selection.labels.size > 0) return null;
  const params = new URLSearchParams({ tab: 'company', view: 'runs', from: range.startKey, to: range.endKey });
  const [agent] = selection.agentIds;
  const [project] = selection.projectIds;
  if (agent) params.set('agent', agent);
  if (project) params.set('project', project);
  return `/ai?${params.toString()}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** Repeats of the same thing closer than this collapse into one. */
export const REPEAT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Collapse repeats: items with the same key, each within `windowMs` of the
 * previous one in its chain, count once (the first). A failure retried every
 * ten minutes for an hour is one incident.
 */
export function collapseRepeats<T>(items: T[], keyOf: (item: T) => string, atOf: (item: T) => number, windowMs = REPEAT_WINDOW_MS): { item: T; last: T; members: T[] }[] {
  const sorted = items.slice().sort((a, b) => atOf(a) - atOf(b));
  const open = new Map<string, { item: T; last: T; members: T[] }>();
  const out: { item: T; last: T; members: T[] }[] = [];
  for (const item of sorted) {
    const key = keyOf(item);
    const chain = open.get(key);
    if (chain && atOf(item) - atOf(chain.last) <= windowMs) {
      chain.last = item;
      chain.members.push(item);
      continue;
    }
    const next = { item, last: item, members: [item] };
    open.set(key, next);
    out.push(next);
  }
  return out;
}

/**
 * Busy time per run: each run keeps the part of its span no earlier run of
 * the same agent already covered. The kept parts sum to the union of the
 * spans (what sweep() measures), so a split by project or model adds up.
 */
export function clipOverlaps<T extends { start: number; end: number }>(spans: T[]): { span: T; ownMs: number }[] {
  const sorted = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let covered = -Infinity;
  return sorted.map((span) => {
    const from = Math.max(span.start, covered);
    const ownMs = Math.max(0, span.end - from);
    covered = Math.max(covered, span.end);
    return { span, ownMs };
  });
}

/** The union of spans, measured with the telemetry model's sweep. */
export function unionMs(spans: { start: number; end: number }[]): number {
  return sweep(spans.map((s) => ({ start: s.start, end: s.end, line: 'work' as const })))
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
}

/** The agent a task's completion belongs to: who claimed it, else its first agent assignee. */
export function taskOwner(task: Pick<Task, 'claimed_by' | 'assignee_ids'>, agentIds: ReadonlySet<string>): string | null {
  if (task.claimed_by && agentIds.has(task.claimed_by)) return task.claimed_by;
  return (task.assignee_ids ?? []).find((id) => agentIds.has(id)) ?? null;
}

/** A turn's or run's pill tone: success and failure for the success rate; the rest is neither. */
const runVerdict = (run: RunRow): 'success' | 'failure' | 'neutral' | 'running' => {
  const pill = runPill({ source: run.source, status: run.status, outcome: run.outcome });
  if (pill.running) return 'running';
  if (pill.tone === 'success') return 'success';
  if (pill.tone === 'danger' || (run.source === 'run' && run.status === 'timed_out')) return 'failure';
  return 'neutral';
};

// ── The read model ──────────────────────────────────────────────────────────

export function buildAgentAnalytics(input: AgentAnalyticsInput): AgentAnalyticsModel {
  const tz = input.timezone;
  const runsAvailable = input.runsAvailable !== false;
  const agentIds = new Set(input.agents.map((a) => a.id));
  const inRange = (key: string) => key >= input.range.startKey && key <= input.range.endKey;
  const keyOfMs = (ms: number) => dateKeyOf(ms, tz);
  const keyOfIso = (iso: string): string | null => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? keyOfMs(ms) : null;
  };
  const agentFilter = input.selectedAgentIds?.size ? input.selectedAgentIds : null;
  const projectFilter = input.selectedProjectIds?.size ? input.selectedProjectIds : null;

  const all: Fact[] = [];
  const push = (kind: FactKind, agentId: string, projectId: string | null, dateKey: string | null, value: number, model: string | null = null, provider: string | null = null, unsplit = false, labels: string[] | null = null) => {
    if (!dateKey || !agentIds.has(agentId) || !inRange(dateKey)) return;
    if (!Number.isFinite(value) || (value === 0 && !isSample(kind))) return;
    all.push({ kind, agentId, projectId: projectId ?? null, model, provider, ...(unsplit ? { unsplit: true } : {}), ...(labels?.length ? { labels } : {}), dateKey, value });
  };
  const labelsOf = (a: AgentActivity): string[] | null => (Array.isArray(a.labels) && a.labels.length > 0 ? a.labels : null);

  // Usage ledger, deduped by its idempotency key. Which agents report one
  // decides where their tokens and cost come from. A row the server summed per
  // hour (the analytics window) has no model, and its cost may merge priced
  // and unpriced records.
  const usageSeen = new Set<string>();
  const usage: { agentId: string; projectId: string | null; dateKey: string; model: string | null; provider: string | null; unsplit: boolean; labels: string[] | null; input: number; output: number; cached: number; cost: number | null }[] = [];
  for (const a of input.activities) {
    if (a.activity_type !== 'usage.recorded' || !agentIds.has(a.agent_id)) continue;
    const m = a.metadata ?? {};
    const sourceId = str(m.source_usage_id) ?? a.id;
    if (usageSeen.has(sourceId)) continue;
    usageSeen.add(sourceId);
    const dateKey = keyOfIso(str(m.recorded_at) ?? a.created_at);
    if (!dateKey || !inRange(dateKey)) continue;
    // Summed per hour by the server: the second window keeps the model (split).
    const unsplit = (typeof m.deltas === 'number' || sourceId.startsWith('hour:')) && m.split !== true;
    const model = unsplit ? null : cleanModel(m.model);
    const rawCost = Number(m.cost_usd);
    usage.push({
      agentId: a.agent_id,
      projectId: a.project_id ?? null,
      dateKey,
      model,
      provider: unsplit ? null : providerOf(model, m.provider),
      unsplit,
      labels: labelsOf(a),
      input: num(m.input_tokens),
      output: num(m.output_tokens),
      cached: num(m.cached_tokens),
      cost: Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null,
    });
  }
  const ledgerAgents = new Set(usage.map((u) => u.agentId));
  // The server's spend (pm.agent_spend_facts, the budget's own count): when
  // it came, it is the only source of tokens and cost, whatever the event
  // window holds or a row cap cut.
  const spend = input.runStats?.spend ?? null;

  for (const u of spend ? [] : usage) {
    const at = (kind: FactKind, value: number) => push(kind, u.agentId, u.projectId, u.dateKey, value, u.model, u.provider, u.unsplit, u.labels);
    at('tokensIn', u.input);
    at('tokensOut', u.output);
    at('tokensCached', u.cached);
    if (u.cost !== null) {
      at('costUsd', u.cost);
      if (u.unsplit) at('mergedCostUsd', u.cost);
    } else {
      at('unpricedTokens', u.input + u.output + u.cached);
    }
  }

  // Runs: counts, success, busy time, and tokens for agents with no ledger.
  // A failure is an incident candidate wherever it falls, so a chain of
  // repeats that began before the range still counts once inside it.
  type Placed = { run: RunRow; start: number; end: number; dateKey: string; model: string | null; provider: string | null };
  const byAgent = new Map<string, Placed[]>();
  type Candidate = { agentId: string; projectId: string | null; model: string | null; provider: string | null; at: number; signature: string; labels?: string[] | null };
  const incidentCandidates: Candidate[] = [];

  // A stored run that reports no tokens takes its attached turns' own tokens
  // (a turn names its run by run_id; tokens_scope turn only, as the run feed
  // reads a turn). Null where no attached turn reported that side.
  const attached = new Map<string, { input: number | null; output: number | null }>();
  for (const a of input.activities) {
    if (a.activity_type !== 'turn.completed') continue;
    const m = a.metadata ?? {};
    const runId = str(m.run_id);
    if (!runId || m.tokens_scope !== 'turn' || !m.tokens || typeof m.tokens !== 'object') continue;
    const t = m.tokens as Record<string, unknown>;
    const sum = attached.get(runId) ?? { input: null, output: null };
    if ('input' in t) sum.input = (sum.input ?? 0) + num(t.input);
    if ('output' in t) sum.output = (sum.output ?? 0) + num(t.output);
    attached.set(runId, sum);
  }

  const runRows = input.runStats ? [] : input.runs;
  for (const row of runRows) {
    const fill = row.source === 'run' && row.tokensIn === null && row.tokensOut === null && row.id ? attached.get(row.id) : undefined;
    const run = fill ? { ...row, tokensIn: fill.input, tokensOut: fill.output } : row;
    if (!agentIds.has(run.agentId)) continue;
    const start = Date.parse(run.startedAt);
    if (!Number.isFinite(start)) continue;
    const dateKey = keyOfMs(start);
    const model = cleanModel(run.model);
    const provider = providerOf(model, run.provider);
    const verdict = runVerdict(run);
    if (verdict === 'failure') {
      incidentCandidates.push({ agentId: run.agentId, projectId: run.projectId, model, provider, at: start, signature: `run:${(run.title ?? '').trim().toLowerCase()}:${run.status}` });
    }
    if (!inRange(dateKey)) continue;
    push('run', run.agentId, run.projectId, dateKey, 1, model, provider);
    if (verdict === 'success') push('runSucceeded', run.agentId, run.projectId, dateKey, 1, model, provider);
    if (verdict === 'failure') push('runFailed', run.agentId, run.projectId, dateKey, 1, model, provider);
    if (verdict === 'running' || run.status === 'waiting') push('runRunning', run.agentId, run.projectId, dateKey, 1, model, provider);
    if (!ledgerAgents.has(run.agentId)) {
      if (run.source === 'run' && run.tokensIn === null && run.tokensOut === null) {
        push('runsNoTokens', run.agentId, run.projectId, dateKey, 1, model, provider);
      }
      const tin = num(run.tokensIn);
      const tout = num(run.tokensOut);
      push('tokensIn', run.agentId, run.projectId, dateKey, tin, model, provider);
      push('tokensOut', run.agentId, run.projectId, dateKey, tout, model, provider);
      const cost = run.costUsd !== null && Number.isFinite(run.costUsd) && run.costUsd > 0 ? run.costUsd : null;
      if (cost !== null) push('costUsd', run.agentId, run.projectId, dateKey, cost, model, provider);
      else push('unpricedTokens', run.agentId, run.projectId, dateKey, tin + tout, model, provider);
    }
    const duration = runDurationMs({ status: run.status, started_at: run.startedAt, finished_at: run.finishedAt, duration_ms: run.durationMs }, input.now);
    if (duration !== null && duration > 0) {
      const list = byAgent.get(run.agentId) ?? [];
      list.push({ run, start, end: start + duration, dateKey, model, provider });
      byAgent.set(run.agentId, list);
    }
  }
  // The server's sums: the same facts, one push per group.
  if (input.runStats) {
    for (const g of input.runStats.groups) {
      const model = cleanModel(g.model);
      const provider = providerOf(model, g.provider);
      const at = (kind: FactKind, value: number) => push(kind, g.agentId, g.projectId, g.dateKey, value, model, provider);
      at('run', g.runs);
      at('runSucceeded', g.succeeded);
      at('runFailed', g.failed);
      if (g.running !== undefined) at('runRunning', g.running);
      at('busyMs', g.busyMs);
      if (!ledgerAgents.has(g.agentId)) {
        at('runsNoTokens', g.runsNoTokens);
        if (!spend) {
          at('tokensIn', g.tokensIn);
          at('tokensOut', g.tokensOut);
          at('costUsd', g.costUsd);
          at('unpricedTokens', g.unpricedTokens);
        }
      }
    }
    for (const g of spend ?? []) {
      const model = cleanModel(g.model);
      const provider = providerOf(model, g.provider);
      const labels = g.labels.length > 0 ? g.labels : null;
      const at = (kind: FactKind, value: number) => push(kind, g.agentId, g.projectId, g.dateKey, value, model, provider, false, labels);
      at('tokensIn', g.tokensIn);
      at('tokensOut', g.tokensOut);
      at('tokensCached', g.tokensCached);
      at('costUsd', g.costUsd);
      at('unpricedTokens', g.unpricedTokens);
    }
    for (const f of input.runStats.failures) {
      if (!agentIds.has(f.agentId)) continue;
      const at = Date.parse(f.startedAt);
      if (!Number.isFinite(at)) continue;
      const model = cleanModel(f.model);
      incidentCandidates.push({ agentId: f.agentId, projectId: f.projectId, model, provider: providerOf(model, f.provider), at, signature: `run:${(f.title ?? '').trim().toLowerCase()}:${f.status}` });
    }
  }

  // Busy time. Unfiltered, an agent's runs clip against each other, so the
  // split by project adds up to its union. Under a project filter, only the
  // filtered runs clip against each other, so the slice stands on its own
  // (a run elsewhere never takes its time).
  for (const [agentId, spans] of byAgent) {
    const scoped = projectFilter ? spans.filter((p) => p.run.projectId !== null && projectFilter.has(p.run.projectId)) : spans;
    for (const { span, ownMs } of clipOverlaps(scoped)) {
      push('busyMs', agentId, span.run.projectId, span.dateKey, ownMs, span.model, span.provider);
    }
  }

  // Host failure records: one per failed fire.
  const failSeen = new Set<string>();
  for (const a of input.activities) {
    if (a.activity_type !== 'turn.failed' || !agentIds.has(a.agent_id)) continue;
    const m = a.metadata ?? {};
    const key = `${a.agent_id}:${str(m.source_turn_id) ?? a.id}`;
    if (failSeen.has(key)) continue;
    failSeen.add(key);
    const at = Date.parse(str(m.finished_at) ?? str(m.started_at) ?? a.created_at);
    if (!Number.isFinite(at)) continue;
    incidentCandidates.push({ agentId: a.agent_id, projectId: a.project_id ?? null, model: null, provider: null, at, signature: `fail:${str(m.job_name) ?? ''}:${str(m.failure) ?? 'failed'}`, labels: labelsOf(a) });
  }
  // A chain counts once when any part of it falls in the range, on the day of
  // its first part in range.
  for (const { members } of collapseRepeats(incidentCandidates, (c) => `${c.agentId}:${c.signature}`, (c) => c.at)) {
    const first = members.find((c) => inRange(keyOfMs(c.at)));
    if (first) push('incident', first.agentId, first.projectId, keyOfMs(first.at), 1, first.model, first.provider, false, first.labels ?? null);
  }

  // Pull requests and reviews, with the delivery model's dedupe: the first
  // hand-off of a PR owns it, a merge counts once and goes to that owner.
  const handoffOwner = new Map<string, string>();
  for (const a of input.activities) {
    if (a.activity_type !== 'work.handoff' || !agentIds.has(a.agent_id)) continue;
    const pr = normalizePullRequestUrl(a.metadata?.pr_url);
    if (pr && !handoffOwner.has(pr)) handoffOwner.set(pr, a.agent_id);
  }
  const opened = new Set<string>();
  const merged = new Set<string>();
  const reviews = new Set<string>();
  const ordered = input.activities.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const a of ordered) {
    const m = a.metadata ?? {};
    if (a.activity_type === 'work.handoff') {
      const pr = normalizePullRequestUrl(m.pr_url);
      const dateKey = keyOfIso(a.created_at);
      if (!pr || opened.has(pr) || !dateKey || !inRange(dateKey) || !agentIds.has(a.agent_id)) continue;
      opened.add(pr);
      push('prOpened', a.agent_id, a.project_id, dateKey, 1, null, null, false, labelsOf(a));
    } else if (a.activity_type === 'pr.merged') {
      const pr = normalizePullRequestUrl(m.pr_url);
      const dateKey = keyOfIso(a.created_at);
      if (!pr || merged.has(pr) || !dateKey || !inRange(dateKey)) continue;
      const owner = handoffOwner.get(pr) ?? a.agent_id;
      if (!agentIds.has(owner)) continue;
      merged.add(pr);
      push('prMerged', owner, a.project_id, dateKey, 1, null, null, false, labelsOf(a));
    } else if (a.activity_type === 'review.started' || a.activity_type === 'review.verdict') {
      const dateKey = keyOfIso(a.created_at);
      if (!dateKey || !inRange(dateKey) || !agentIds.has(a.agent_id)) continue;
      const subject = normalizePullRequestUrl(m.pr_url) ?? str(m.task_id) ?? a.reference_id ?? a.id;
      const key = `${a.agent_id}:${subject}:${num(m.round)}`;
      if (reviews.has(key)) continue;
      reviews.add(key);
      push('review', a.agent_id, a.project_id, dateKey, 1, null, null, false, labelsOf(a));
    }
  }

  // Blocked: repeats on the same task collapse; the wait ends at the agent's
  // next real step on that task.
  const blockedEvents = ordered
    .filter((a) => a.activity_type === 'blocked' && agentIds.has(a.agent_id))
    .map((a) => ({ a, taskId: str(a.metadata?.task_id) ?? a.reference_id ?? null, at: Date.parse(a.created_at) }))
    .filter((b) => Number.isFinite(b.at));
  const touches = ordered.filter((a) => a.activity_type !== 'blocked' && !isTelemetryEvent(a.activity_type) && !isOpenEventType(a.activity_type));
  for (const { item, last } of collapseRepeats(blockedEvents, (b) => `${b.a.agent_id}:${b.taskId ?? b.a.id}`, (b) => b.at)) {
    const dateKey = keyOfMs(item.at);
    push('blocked', item.a.agent_id, item.a.project_id, dateKey, 1, null, null, false, labelsOf(item.a));
    if (!item.taskId) continue;
    const resume = touches.find((t) => t.agent_id === item.a.agent_id
      && (str(t.metadata?.task_id) ?? t.reference_id) === item.taskId
      && Date.parse(t.created_at) > last.at);
    if (resume) push('resumeMs', item.a.agent_id, item.a.project_id, dateKey, Date.parse(resume.created_at) - item.at, null, null, false, labelsOf(item.a));
  }

  // Questions and approvals the agents asked: the server's sums, else rows.
  for (const g of input.questionStats?.groups ?? []) {
    push('question', g.askedBy, g.projectId, g.dateKey, g.questions);
    push('approval', g.askedBy, g.projectId, g.dateKey, g.approvals);
    for (const ms of g.answerMs) push('answerMs', g.askedBy, g.projectId, g.dateKey, ms);
  }
  for (const q of input.questionStats ? [] : input.questions) {
    if (!agentIds.has(q.askedBy)) continue;
    const created = Date.parse(q.createdAt);
    if (!Number.isFinite(created)) continue;
    const dateKey = keyOfMs(created);
    push(q.kind === 'approval' ? 'approval' : 'question', q.askedBy, q.projectId, dateKey, 1);
    const answered = q.answeredAt ? Date.parse(q.answeredAt) : NaN;
    if (Number.isFinite(answered) && answered >= created) push('answerMs', q.askedBy, q.projectId, dateKey, answered - created);
  }

  // Tasks completed, each by one owner, and reopens of agent tasks.
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  for (const task of input.tasks) {
    if (!task.completed_at) continue;
    const owner = taskOwner(task, agentIds);
    if (owner) push('taskDone', owner, task.project_id ?? null, keyOfIso(task.completed_at), 1);
  }
  for (const reopen of input.reopens ?? []) {
    const task = taskById.get(reopen.taskId);
    const owner = task ? taskOwner(task, agentIds) : null;
    if (owner) push('reopen', owner, reopen.projectId ?? task?.project_id ?? null, keyOfIso(reopen.reopenedAt), 1);
  }

  // Billable time, with the Finances rules: approved time is revenue
  // (approval_status === 'approved', exactly), everything else waits. The
  // rate is the entry's snapshot, else the project's hourly rate.
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const rateOf = (entry: TimeEntry) => {
    const project = projectById.get(entry.project_id);
    return entry.hourly_rate ?? (project?.hourly_tracking ? project.hourly_rate ?? 0 : 0);
  };
  for (const entry of input.timeEntries) {
    if (!agentIds.has(entry.member_id) || entry.work_type === 'internal') continue;
    const rate = rateOf(entry);
    if (!(rate > 0)) continue;
    const approved = entry.approval_status === 'approved';
    for (const [dateKey, hours] of getWorkedHoursByDay(projectTimeEntryForBilling(entry, input.now), input.now)) {
      if (approved) {
        push('revenue', entry.member_id, entry.project_id, dateKey, hours * rate);
        push('billableHours', entry.member_id, entry.project_id, dateKey, hours);
      } else {
        push('pendingRevenue', entry.member_id, entry.project_id, dateKey, hours * rate);
      }
    }
  }

  // The selection: agents, then projects. Facts with no project leave under a
  // project filter; the usage among them is what profit has to exclude.
  const labelFilter = input.selectedLabels?.size ? input.selectedLabels : null;
  const ofAgents = all.filter((f) => (!agentFilter || agentFilter.has(f.agentId))
    && (!labelFilter || (f.labels ?? []).some((label) => labelFilter.has(label))));
  const facts = ofAgents.filter((f) => !projectFilter || (f.projectId !== null && projectFilter.has(f.projectId)));
  const totals = groupOf(facts);
  const dropped = projectFilter ? groupOf(ofAgents.filter((f) => f.projectId === null)).sums : null;
  const excludedNoProject = { costUsd: dropped?.costUsd ?? 0, unpricedTokens: dropped?.unpricedTokens ?? 0 };

  const selectedAgents = input.agents.filter((a) => !agentFilter || agentFilter.has(a.id));
  const valueBy = groupBy(facts, (f) => f.agentId);
  const money = moneyVisibility({
    billingModuleOn: input.billingModuleOn,
    canReadRevenue: input.canReadRevenue,
    agents: selectedAgents.map((agent) => ({
      agentId: agent.id,
      billableValue: valueBy.get(agent.id)?.sums.revenue ?? 0,
      pendingValue: valueBy.get(agent.id)?.sums.pendingRevenue ?? 0,
      hasBillingRate: input.timeEntries.some((e) => e.member_id === agent.id && e.work_type !== 'internal'
        && (!projectFilter || projectFilter.has(e.project_id)) && rateOf(e) > 0),
    })),
  });

  return {
    facts, totals, money, tiles: tileStates(totals.sums, money, runsAvailable), ledgerAgents, excludedNoProject, runsAvailable,
    subscription: subscriptionEstimate(input.providerPlans ?? [], all, facts, rangeDays(input.range).length),
  };
}

const providerKey = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/**
 * What the provider plans cost, as an estimate: each plan's monthly cost
 * (per seat x seats), prorated to the range's days, then shared by the
 * selection's part of that provider's unpriced tokens in the range (usage on
 * a subscription arrives with no price). A provider with no unpriced tokens
 * in the range allocates nothing. Never added to measured cost.
 */
export function subscriptionEstimate(plans: ProviderPlan[], all: Fact[], selected: Fact[], days: number): SubscriptionEstimate | null {
  const usable = plans.filter((p) => providerKey(p.provider) && Number.isFinite(p.monthlyCostUsd) && p.monthlyCostUsd >= 0);
  if (usable.length === 0) return null;
  const unpriced = (facts: Fact[]) => {
    const out = new Map<string, number>();
    for (const f of facts) if (f.kind === 'unpricedTokens') out.set(providerKey(f.provider), (out.get(providerKey(f.provider)) ?? 0) + f.value);
    return out;
  };
  const everyone = unpriced(all);
  const mine = unpriced(selected);
  let monthlyUsd = 0;
  let estimateUsd = 0;
  for (const plan of usable) {
    const monthly = plan.monthlyCostUsd * Math.max(1, plan.seats);
    monthlyUsd += monthly;
    const total = everyone.get(providerKey(plan.provider)) ?? 0;
    if (total > 0) estimateUsd += monthly * (12 / 365) * days * ((mine.get(providerKey(plan.provider)) ?? 0) / total);
  }
  return { monthlyUsd, estimateUsd, providers: usable.map((p) => p.provider) };
}

// ── Breakdowns ──────────────────────────────────────────────────────────────

export type Dimension = 'agent' | 'project' | 'model' | 'role' | 'label';

export interface BreakdownRow {
  key: string;
  label: string;
  /** A second line: the provider, for a model. */
  sublabel: string | null;
  group: Group;
}

export interface BreakdownLabels {
  agentName: (id: string) => string;
  projectName: (id: string) => string;
  roleOf: (agentId: string) => string | null;
}

export const NO_PROJECT = 'No project';
export const NO_MODEL = 'Model not reported';
export const UNSPLIT_MODEL = 'Usage not split by model yet';
export const UNSPLIT_SUBLABEL = 'Summed per hour by the server';
export const NO_PROVIDER = 'Provider not reported';
export const NO_ROLE = 'No role';
export const NO_LABEL = 'No label';

const SEP = '\u0000';
const UNSPLIT_KEY = '\u0001unsplit';

/** The key a fact files under for a dimension. Every fact has exactly one, so the rows add up to the total. */
export function dimensionKey(fact: Fact, dimension: Dimension, roleOf: (agentId: string) => string | null): string {
  switch (dimension) {
    case 'agent': return fact.agentId;
    case 'project': return fact.projectId ?? '';
    case 'model': return fact.unsplit ? UNSPLIT_KEY : `${fact.provider ?? ''}${SEP}${fact.model ?? ''}`;
    case 'role': return roleOf(fact.agentId) ?? '';
    // A fact with several labels files under the first here; breakdown() files it under each.
    case 'label': return fact.labels?.[0] ?? '';
  }
}

/**
 * Facts under each of their labels (none: the No label row). A fact with
 * two labels counts on both rows, so label rows may add up to more than the
 * total; every other dimension adds up exactly.
 */
export function factsByLabel(facts: Fact[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const fact of facts) {
    for (const key of fact.labels?.length ? [...new Set(fact.labels)] : ['']) {
      let group = out.get(key);
      if (!group) { group = emptyGroup(); out.set(key, group); }
      addFact(group, fact);
    }
  }
  return out;
}

export function breakdown(facts: Fact[], dimension: Dimension, labels: BreakdownLabels): BreakdownRow[] {
  const groups = dimension === 'label' ? factsByLabel(facts) : groupBy(facts, (f) => dimensionKey(f, dimension, labels.roleOf));
  return [...groups].map(([key, group]) => {
    switch (dimension) {
      case 'agent': return { key, label: labels.agentName(key), sublabel: labels.roleOf(key), group };
      case 'project': return { key, label: key ? labels.projectName(key) : NO_PROJECT, sublabel: null, group };
      case 'role': return { key, label: key || NO_ROLE, sublabel: null, group };
      case 'label': return { key, label: key || NO_LABEL, sublabel: null, group };
      case 'model': {
        if (key === UNSPLIT_KEY) return { key, label: UNSPLIT_MODEL, sublabel: UNSPLIT_SUBLABEL, group };
        const [provider, model] = key.split(SEP);
        return { key, label: model || NO_MODEL, sublabel: provider || NO_PROVIDER, group };
      }
    }
  });
}

/**
 * Rows ranked by a metric (ties by name), narrowed by a search over the
 * labels, and cut to `limit`. Built for a hundred agents: the screen shows a
 * window and says how many more there are.
 */
export function rankRows(rows: BreakdownRow[], metric: MetricKey, options: { search?: string; limit: number }): { rows: BreakdownRow[]; matched: number; more: number } {
  const q = options.search?.trim().toLowerCase() ?? '';
  const matched = rows
    .filter((r) => !q || r.label.toLowerCase().includes(q) || (r.sublabel ?? '').toLowerCase().includes(q))
    .sort((a, b) => metricValue(metric, b.group.sums) - metricValue(metric, a.group.sums) || a.label.localeCompare(b.label));
  const shown = matched.slice(0, Math.max(0, options.limit));
  return { rows: shown, matched: matched.length, more: matched.length - shown.length };
}

// ── Series ──────────────────────────────────────────────────────────────────

/** Every day of the range, oldest first. */
export function rangeDays(range: DateRange): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = range.startKey.split('-').map(Number);
  const [ey, em, ed] = range.endKey.split('-').map(Number);
  const end = Date.UTC(ey, em - 1, ed);
  for (let t = Date.UTC(sy, sm - 1, sd); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export interface DayPoint {
  dateKey: string;
  /** The metric per agent that day (signed for profit). */
  perAgent: Map<string, number>;
  total: number;
}

/** One metric per day of the range, split by agent: the chart's bars and the tile's sparkline. */
export function dailyByAgent(facts: Fact[], metric: MetricKey, days: string[]): DayPoint[] {
  const groups = groupBy(facts, (f) => `${f.dateKey}${SEP}${f.agentId}`);
  const byDay = new Map(days.map((d) => [d, { dateKey: d, perAgent: new Map<string, number>(), total: 0 }]));
  for (const [key, group] of groups) {
    const [dateKey, agentId] = key.split(SEP);
    const point = byDay.get(dateKey);
    if (!point) continue;
    const value = metricValue(metric, group.sums);
    if (value === 0) continue;
    point.perAgent.set(agentId, value);
    point.total += value;
  }
  return days.map((d) => byDay.get(d)!);
}

/**
 * The agents the chart stacks by name: the top `limit` by the metric's total
 * in the selection (absolute, so a loss ranks too); the rest share one
 * "Other agents" segment.
 */
export function topAgents(facts: Fact[], metric: MetricKey, limit: number): { ids: string[]; others: boolean } {
  const ranked = [...groupBy(facts, (f) => f.agentId)]
    .map(([id, group]) => ({ id, value: metricValue(metric, group.sums) }))
    .filter((r) => r.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.id.localeCompare(b.id));
  return { ids: ranked.slice(0, limit).map((r) => r.id), others: ranked.length > limit };
}

/** Success rate over runs that ended in success or failure; null with none. */
export function successRate(s: Sums): number | null {
  const decided = s.runSucceeded + s.runFailed;
  return decided > 0 ? s.runSucceeded / decided : null;
}

/**
 * How runs ended, in plain words, counting only finished ones: running runs
 * never count as succeeded. The tile reads "1 succeeded, 0 failed · 14
 * running"; a breakdown cell (short) reads "1 of 1 ok · 14 running". Nothing
 * finished yet says so instead of a rate.
 */
export function runOutcomeLine(s: Pick<Sums, 'runSucceeded' | 'runFailed' | 'runRunning'>, short = false): string {
  const decided = s.runSucceeded + s.runFailed;
  const running = s.runRunning > 0 ? `${s.runRunning} running` : null;
  if (decided === 0) return running ? `${running}, none finished yet` : 'None finished yet';
  const ended = short ? `${s.runSucceeded} of ${decided} ok` : `${s.runSucceeded} succeeded, ${s.runFailed} failed`;
  return running ? `${ended} · ${running}` : ended;
}

/** Margin over revenue; null without revenue. */
export function marginOf(s: Sums): number | null {
  return s.revenue > 0 ? (s.revenue - s.costUsd) / s.revenue : null;
}
