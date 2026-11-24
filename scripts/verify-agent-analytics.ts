/**
 * The Agents page's Analytics tab read model (src/lib/agent-analytics-model.ts):
 * when money shows, how cost is labelled, that every breakdown adds up to the
 * total, which tiles show and drive the chart, and that runs and turns are
 * never counted twice. Pure logic; nothing touches a database.
 *
 *   npm run -s test:agent-analytics
 */
import {
  DEFAULT_TILE_CAP, METRIC_KEYS, MIXED_LABEL, RUN_METRICS, SCOPE_QUESTIONS, SCOPE_TASKS, SCOPE_TIME, SUM_KINDS, UNPRICED_LABEL, UNSPLIT_MODEL,
  arrangeTiles, breakdown, buildAgentAnalytics, clipOverlaps, collapseRepeats, costLabel, costText, dailyByAgent,
  groupOf, metricValue, moneyVisibility, profitCaveat, providerOf, rangeDays, rankRows, resolveSelectedMetric, runsFromTurns,
  scopeNotes, successRate, tileStates, unionMs, type AgentAnalyticsInput, type Dimension, type Fact, type MetricKey, type RunRow, type Sums,
} from '@/lib/agent-analytics-model';
import { activitiesFromWindow, type AnalyticsWindowPayload } from '@/lib/agent-analytics-window';
import { keysetPages, type PageCursor } from '@/lib/agent-analytics-paging';
import { computeFinanceAttribution } from '@/lib/finance/summary';
import { agentsTabFrom, AGENTS_TAB_LABELS } from '@/lib/agents-tab';
import type { AgentActivity, Project, TeamMember, TimeEntry } from '@/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const BUILDER = 'a1';
const REVIEWER = 'a2';
const HELPER = 'a3';
const PERSON = 'p1';
const SITE = 'proj-site';
const APP = 'proj-app';
const TZ = 'UTC';
const range = { startKey: '2026-11-01', endKey: '2026-11-07' };
const NOW = Date.parse('2026-11-07T20:00:00Z');

let seq = 0;
const act = (agent: string, type: string, at: string, metadata: Record<string, unknown> = {}, project: string | null = null, reference: string | null = null): AgentActivity => ({
  id: `act-${++seq}`, agent_id: agent, project_id: project, activity_type: type, title: '', description: '',
  reference_id: reference, reference_type: reference ? 'task' : null, metadata, created_at: at,
});

const run = (over: Partial<RunRow> & Pick<RunRow, 'agentId' | 'startedAt'>): RunRow => ({
  source: 'run', projectId: null, status: 'succeeded', outcome: null, title: 'Run', model: null,
  finishedAt: null, durationMs: null, tokensIn: null, tokensOut: null, costUsd: null, ...over,
});

const entry = (member: string, project: string, start: string, end: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `te-${++seq}`, project_id: project, member_id: member, start_time: start, end_time: end,
  segments: [{ start, end }], description: '', created_at: start, updated_at: end, approval_status: 'approved', ...over,
});

const base = (over: Partial<AgentAnalyticsInput> = {}): AgentAnalyticsInput => ({
  range, timezone: TZ, now: NOW,
  agents: [
    { id: BUILDER, name: 'Builder', role: 'builder' },
    { id: REVIEWER, name: 'Reviewer', role: 'code-reviewer' },
    { id: HELPER, name: 'Helper', role: null },
  ],
  projects: [
    { id: SITE, hourly_tracking: true, hourly_rate: 100 },
    { id: APP, hourly_tracking: false, hourly_rate: null },
  ],
  runs: [], activities: [], questions: [], tasks: [], reopens: [], timeEntries: [],
  billingModuleOn: true, canReadRevenue: true, ...over,
});

// ── The tab is Analytics; old links still open it ──────────────────────
check('the tab is called Analytics', AGENTS_TAB_LABELS.analytics === 'Analytics');
check('?tab=analytics opens Analytics', agentsTabFrom('analytics') === 'analytics');
check('?tab=usage (old links) opens Analytics', agentsTabFrom('usage') === 'analytics');

// ── Billing visibility ─────────────────────────────────────────────────
const sig = (over: Partial<{ billableValue: number; pendingValue: number; hasBillingRate: boolean }> = {}) =>
  ({ agentId: 'x', billableValue: 0, pendingValue: 0, hasBillingRate: false, ...over });
check('module off hides money even with billable work',
  moneyVisibility({ billingModuleOn: false, canReadRevenue: true, agents: [sig({ billableValue: 500, hasBillingRate: true })] }).show === false);
check('module off says why', moneyVisibility({ billingModuleOn: false, canReadRevenue: true, agents: [] }).reason === 'module_off');
check('module on but nobody bills hides money',
  moneyVisibility({ billingModuleOn: true, canReadRevenue: true, agents: [sig(), sig()] }).show === false);
check('nobody bills says why', moneyVisibility({ billingModuleOn: true, canReadRevenue: true, agents: [sig()] }).reason === 'nothing_billable');
check('one agent with approved billable work shows money', moneyVisibility({ billingModuleOn: true, canReadRevenue: true, agents: [sig(), sig({ billableValue: 10 })] }).show === true);
check('pending billable work alone shows money', moneyVisibility({ billingModuleOn: true, canReadRevenue: true, agents: [sig({ pendingValue: 10 })] }).show === true);
check('a billing rate with no work this window shows money', moneyVisibility({ billingModuleOn: true, canReadRevenue: true, agents: [sig({ hasBillingRate: true })] }).show === true);
check('without billing.manage or finance.company.read, money is hidden even when agents bill',
  moneyVisibility({ billingModuleOn: true, canReadRevenue: false, agents: [sig({ billableValue: 500 })] }).show === false);
check('no permission says why', moneyVisibility({ billingModuleOn: true, canReadRevenue: false, agents: [sig({ billableValue: 1 })] }).reason === 'no_permission');

{
  // An internal team: agents with runs and internal time only. No money tiles at all.
  const internal = buildAgentAnalytics(base({
    runs: [run({ agentId: BUILDER, startedAt: '2026-11-02T10:00:00Z', durationMs: 60_000 })],
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', { work_type: 'internal' })],
  }));
  check('internal-only time hides money', internal.money.show === false);
  check('internal team: no revenue or profit tile, not even under More stats',
    !internal.tiles.some((t) => t.key === 'revenue' || t.key === 'profit'));

  const billing = buildAgentAnalytics(base({
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
  }));
  check('an agent billing at the project rate shows money', billing.money.show === true);
  check('revenue is approved hours times the rate', billing.totals.sums.revenue === 200, billing.totals.sums.revenue);
  check('money tiles lead when shown', billing.tiles[0].key === 'revenue' && billing.tiles[1].key === 'profit');

  const off = buildAgentAnalytics(base({
    billingModuleOn: false,
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
  }));
  check('billing module off: no money tiles even with billed hours', off.money.show === false && !off.tiles.some((t) => t.key === 'revenue'));

  const noPerm = buildAgentAnalytics(base({
    canReadRevenue: false,
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
  }));
  check('a viewer who cannot read revenue gets no money tiles', noPerm.money.show === false && !noPerm.tiles.some((t) => t.key === 'revenue' || t.key === 'profit'));

  // The selection decides: filtered to an agent that does not bill, money goes.
  const filtered = buildAgentAnalytics(base({
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
    selectedAgentIds: new Set([REVIEWER]),
  }));
  check('filtered to a non-billing agent hides money', filtered.money.show === false);

  // A rate on a project with no hourly tracking and no snapshot is not a rate.
  const noRate = buildAgentAnalytics(base({
    timeEntries: [entry(BUILDER, APP, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
  }));
  check('time on an unrated project does not show money', noRate.money.show === false);
}

// ── Cost labelling ─────────────────────────────────────────────────────
const sums = (over: Partial<Sums>): Sums => ({ ...Object.fromEntries(SUM_KINDS.map((k) => [k, 0])) as Sums, ...over });
const money = (usd: number) => `$${usd.toFixed(2)}`;
check('tokens with no cost read as subscription or unpriced, never $0',
  costText(costLabel(sums({ tokensIn: 1000, tokensOut: 200 })), money) === UNPRICED_LABEL);
check('priced tokens read as money', costText(costLabel(sums({ tokensIn: 1000, costUsd: 1.5 })), money) === '$1.50');
check('part priced reads as money plus unpriced',
  costText(costLabel(sums({ tokensIn: 1000, costUsd: 1.5, unpricedTokens: 400 })), money) === '$1.50 + unpriced');
check('no tokens and no cost reads as nothing', costText(costLabel(sums({})), money) === null);
check('provider comes from the record when it names one', providerOf('gpt-5', 'acme') === 'acme');
check('provider comes from a provider/model string', providerOf('openrouter/some-model') === 'openrouter');
check('a bare model names no provider', providerOf('some-model') === null && providerOf(null) === null);

{
  const model = buildAgentAnalytics(base({
    activities: [
      act(BUILDER, 'usage.recorded', '2026-11-02T10:00:00Z', { source_usage_id: 'u1', model: 'vendor-a/model-x', input_tokens: 1000, output_tokens: 100, cached_tokens: 0, cost_usd: 0 }),
      act(BUILDER, 'usage.recorded', '2026-11-02T11:00:00Z', { source_usage_id: 'u1', model: 'vendor-a/model-x', input_tokens: 1000, output_tokens: 100, cached_tokens: 0, cost_usd: 0 }),
      act(REVIEWER, 'usage.recorded', '2026-11-03T10:00:00Z', { source_usage_id: 'u2', model: 'model-y', provider: 'vendor-b', input_tokens: 500, output_tokens: 50, cached_tokens: 10, cost_usd: 0.25 }),
    ],
  }));
  check('a usage record repeated by the publisher counts once', model.totals.sums.tokensIn === 1500, model.totals.sums.tokensIn);
  check('overall cost is partial: one priced, one unpriced', costLabel(model.totals.sums).kind === 'partial');
  const byModel = breakdown(model.facts, 'model', { agentName: (id) => id, projectName: (id) => id, roleOf: () => null });
  const x = byModel.find((r) => r.label === 'vendor-a/model-x');
  const y = byModel.find((r) => r.label === 'model-y');
  check('a $0 model reads as unpriced on its own row', !!x && costLabel(x.group.sums).kind === 'unpriced', x?.group.sums);
  check('a priced model reads as priced', !!y && costLabel(y.group.sums).kind === 'priced' && y.sublabel === 'vendor-b');
  check('cost tile shows whenever tokens exist, even unpriced', model.tiles.find((t) => t.key === 'cost')?.hasData === true);
  const unpricedOnly = buildAgentAnalytics(base({
    activities: [act(BUILDER, 'usage.recorded', '2026-11-02T10:00:00Z', { source_usage_id: 'u9', model: 'm', input_tokens: 10, output_tokens: 1, cached_tokens: 0, cost_usd: 0 })],
  }));
  check('all-unpriced still keeps the cost tile', unpricedOnly.tiles.find((t) => t.key === 'cost')?.hasData === true);
  check('cost sits after tokens and runtime', METRIC_KEYS.indexOf('cost') > METRIC_KEYS.indexOf('tokens') && METRIC_KEYS.indexOf('cost') > METRIC_KEYS.indexOf('busy'));
}

// ── Totals reconcile across every breakdown ────────────────────────────
const rich = base({
  runs: [
    run({ agentId: BUILDER, projectId: SITE, startedAt: '2026-11-02T10:00:00Z', durationMs: 60 * 60_000, model: 'vendor-a/m1', tokensIn: 1000, tokensOut: 200, costUsd: 0.5 }),
    // Overlaps the first by 30 minutes on another project.
    run({ agentId: BUILDER, projectId: APP, startedAt: '2026-11-02T10:30:00Z', durationMs: 60 * 60_000, model: 'm2', tokensIn: 300, tokensOut: 30, status: 'failed', title: 'Deploy' }),
    run({ agentId: BUILDER, projectId: APP, startedAt: '2026-11-02T10:40:00Z', durationMs: 5 * 60_000, status: 'failed', title: 'Deploy' }),
    run({ agentId: REVIEWER, projectId: SITE, startedAt: '2026-11-03T09:00:00Z', durationMs: 20 * 60_000, source: 'turn', outcome: 'work', tokensIn: 50, tokensOut: 5 }),
    run({ agentId: HELPER, startedAt: '2026-11-04T09:00:00Z', durationMs: 10 * 60_000, source: 'turn', outcome: 'blocked' }),
    // Outside the window: never counted.
    run({ agentId: BUILDER, projectId: SITE, startedAt: '2026-10-20T09:00:00Z', durationMs: 10 * 60_000 }),
  ],
  activities: [
    act(BUILDER, 'work.handoff', '2026-11-02T12:00:00Z', { pr_url: 'https://github.com/o/r/pull/1' }, SITE),
    act(BUILDER, 'work.handoff', '2026-11-02T13:00:00Z', { pr_url: 'https://github.com/o/r/pull/1/' }, SITE),
    act(REVIEWER, 'review.started', '2026-11-03T08:00:00Z', { pr_url: 'https://github.com/o/r/pull/1', round: 1 }, SITE),
    act(REVIEWER, 'review.verdict', '2026-11-03T09:30:00Z', { pr_url: 'https://github.com/o/r/pull/1', round: 1, verdict: 'approved' }, SITE),
    act(PERSON, 'pr.merged', '2026-11-03T10:00:00Z', { pr_url: 'https://github.com/o/r/pull/1', additions: 1, deletions: 1 }, SITE),
    act(HELPER, 'blocked', '2026-11-04T09:00:00Z', { task_id: 't3', reason: 'creds' }, APP),
    act(HELPER, 'blocked', '2026-11-04T09:20:00Z', { task_id: 't3', reason: 'creds' }, APP),
    act(HELPER, 'work.milestone', '2026-11-04T10:20:00Z', { task_id: 't3', kind: 'note', detail: 'go' }, APP),
    // A ledger agent with cached tokens and a priced record.
    act(HELPER, 'usage.recorded', '2026-11-04T11:00:00Z', { source_usage_id: 'h1', model: 'vendor-c/m3', input_tokens: 70, output_tokens: 7, cached_tokens: 700, cost_usd: 0.07 }, APP),
    // An hour the server summed (the window's shape): no model, cost priced or mixed.
    act(HELPER, 'usage.recorded', '2026-11-04T12:00:00Z', { source_usage_id: 'hour:a3:proj-app:2026-11-04T12:00:00.000Z', input_tokens: 20, output_tokens: 2, cached_tokens: 0, cost_usd: 0.03, deltas: 3 }, APP),
  ],
  questions: [
    { askedBy: BUILDER, projectId: SITE, kind: 'question', createdAt: '2026-11-02T10:00:00Z', answeredAt: '2026-11-02T10:10:00Z' },
    { askedBy: REVIEWER, projectId: null, kind: 'approval', createdAt: '2026-11-03T10:00:00Z', answeredAt: '2026-11-03T10:30:00Z' },
    { askedBy: PERSON, projectId: SITE, kind: 'question', createdAt: '2026-11-03T10:00:00Z', answeredAt: null },
  ],
  tasks: [
    { id: 't1', project_id: SITE, completed_at: '2026-11-02T15:00:00Z', claimed_by: BUILDER, assignee_ids: [REVIEWER] },
    { id: 't2', project_id: APP, completed_at: '2026-11-05T15:00:00Z', claimed_by: null, assignee_ids: [PERSON, REVIEWER] },
    { id: 't4', project_id: APP, completed_at: '2026-11-05T15:00:00Z', claimed_by: null, assignee_ids: [PERSON] },
  ],
  reopens: [{ taskId: 't1', projectId: SITE, reopenedAt: '2026-11-03T12:00:00Z' }],
  timeEntries: [
    entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T11:30:00Z'),
    entry(REVIEWER, SITE, '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', { approval_status: 'pending' }),
  ],
});
const model = buildAgentAnalytics(rich);
check('the fixture exercises every kind', SUM_KINDS.every((k) => model.totals.sums[k] !== 0), SUM_KINDS.filter((k) => model.totals.sums[k] === 0));
const labels = { agentName: (id: string) => id, projectName: (id: string) => id, roleOf: (id: string) => rich.agents.find((a) => a.id === id)?.role ?? null };
for (const dimension of ['agent', 'project', 'model', 'role'] as Dimension[]) {
  const rows = breakdown(model.facts, dimension, labels);
  for (const kind of SUM_KINDS) {
    const viaRows = rows.reduce((s, r) => s + r.group.sums[kind], 0);
    check(`${kind}: total equals the sum by ${dimension}`, Math.abs(viaRows - model.totals.sums[kind]) < 1e-9, { kind, dimension, viaRows, total: model.totals.sums[kind] });
  }
}
// The same totals computed a second way: straight from the facts by kind.
for (const kind of SUM_KINDS) {
  const direct = model.facts.filter((f) => f.kind === kind).reduce((s, f) => s + f.value, 0);
  check(`${kind}: totals equal the facts summed directly`, Math.abs(direct - model.totals.sums[kind]) < 1e-9);
}
// And the chart's days add up to the tile for every metric.
const days = rangeDays(range);
check('the range has every day', days.length === 7 && days[0] === '2026-11-01' && days[6] === '2026-11-07');
for (const metric of METRIC_KEYS) {
  const viaDays = dailyByAgent(model.facts, metric, days).reduce((s, d) => s + d.total, 0);
  check(`${metric}: chart days add up to the tile`, Math.abs(viaDays - metricValue(metric, model.totals.sums)) < 1e-6, { viaDays, tile: metricValue(metric, model.totals.sums) });
}

check('runs in the window: 5 (the October run is out)', model.totals.sums.run === 5, model.totals.sums.run);
check('the PR opened twice counts once', model.totals.sums.prOpened === 1);
check('a merge by a person goes to the agent that handed it off', breakdown(model.facts, 'agent', labels).find((r) => r.key === BUILDER)?.group.sums.prMerged === 1);
check('a review started and given in one round counts once', model.totals.sums.review === 1);
check('a person\'s question is not an agent\'s', model.totals.sums.question === 1 && model.totals.sums.approval === 1);
check('median time to answer', JSON.stringify(model.totals.samples.answerMs.slice().sort((a, b) => a - b)) === JSON.stringify([600_000, 1_800_000]));
check('tasks: claimed goes to the claimer, else the first agent assignee, never a person-only task',
  model.totals.sums.taskDone === 2
  && breakdown(model.facts, 'agent', labels).find((r) => r.key === REVIEWER)?.group.sums.taskDone === 1);
check('a reopen goes to the task\'s agent', breakdown(model.facts, 'agent', labels).find((r) => r.key === BUILDER)?.group.sums.reopen === 1);
check('repeated blocked on one task inside an hour counts once', model.totals.sums.blocked === 1);
check('blocked waits until the next step, from the first block', JSON.stringify(model.totals.samples.resumeMs) === JSON.stringify([80 * 60_000]));
check('a failed deploy repeated within the hour is one incident', model.totals.sums.incident === 1, model.totals.sums.incident);
check('success rate counts successes over successes and failures (a blocked turn is neither)',
  successRate(model.totals.sums) === 2 / 4, { s: model.totals.sums.runSucceeded, f: model.totals.sums.runFailed });

// Busy time: overlaps merged, two ways.
const builderSpans = [
  { start: Date.parse('2026-11-02T10:00:00Z'), end: Date.parse('2026-11-02T11:00:00Z') },
  { start: Date.parse('2026-11-02T10:30:00Z'), end: Date.parse('2026-11-02T11:30:00Z') },
  { start: Date.parse('2026-11-02T10:40:00Z'), end: Date.parse('2026-11-02T10:45:00Z') },
];
const clipped = clipOverlaps(builderSpans).reduce((s, c) => s + c.ownMs, 0);
check('busy time: the clipped runs equal the sweep union', clipped === unionMs(builderSpans) && clipped === 90 * 60_000, { clipped, union: unionMs(builderSpans) });
const builderBusy = breakdown(model.facts, 'agent', labels).find((r) => r.key === BUILDER)?.group.sums.busyMs;
check('busy time per agent merges its overlapping runs (90m, not 125m)', builderBusy === 90 * 60_000, builderBusy);
const siteBusy = breakdown(model.facts, 'project', labels).find((r) => r.key === SITE)?.group.sums.busyMs;
const appBusy = breakdown(model.facts, 'project', labels).find((r) => r.key === APP)?.group.sums.busyMs;
check('busy time splits by project into parts of the union', siteBusy === 60 * 60_000 + 20 * 60_000 && appBusy === 30 * 60_000, { siteBusy, appBusy });

// Project filter: every fact left belongs to the project; nothing without one.
const siteOnly = buildAgentAnalytics({ ...rich, selectedProjectIds: new Set([SITE]) });
check('a project filter keeps only that project\'s facts', siteOnly.facts.every((f) => f.projectId === SITE));
check('a project filter total equals that project\'s row', siteOnly.totals.sums.run === breakdown(model.facts, 'project', labels).find((r) => r.key === SITE)?.group.sums.run);

// ── Token source: ledger or runs, never both ───────────────────────────
{
  const both = buildAgentAnalytics(base({
    runs: [
      run({ agentId: BUILDER, startedAt: '2026-11-02T10:00:00Z', durationMs: 1000, tokensIn: 999, tokensOut: 99, costUsd: 9 }),
      run({ agentId: REVIEWER, startedAt: '2026-11-02T10:00:00Z', durationMs: 1000, tokensIn: 40, tokensOut: 4, costUsd: 0.4 }),
    ],
    activities: [act(BUILDER, 'usage.recorded', '2026-11-02T10:00:00Z', { source_usage_id: 'u1', model: 'm', input_tokens: 100, output_tokens: 10, cached_tokens: 0, cost_usd: 1 })],
  }));
  check('an agent with a usage ledger is measured from it, not its runs', both.ledgerAgents.has(BUILDER) && !both.ledgerAgents.has(REVIEWER));
  check('tokens in: ledger 100 plus the other agent\'s runs 40', both.totals.sums.tokensIn === 140, both.totals.sums.tokensIn);
  check('cost: ledger 1 plus runs 0.4, never the ledger agent\'s run cost', Math.abs(both.totals.sums.costUsd - 1.4) < 1e-9, both.totals.sums.costUsd);
}

// ── Runs and turns never double counted ────────────────────────────────
{
  const turns = [
    act(BUILDER, 'turn.completed', '2026-11-02T10:05:00Z', { source_turn_id: 's1', origin: 'scheduled', outcome: 'work', duration_ms: 60_000, started_at: '2026-11-02T10:04:00Z' }),
    act(BUILDER, 'turn.completed', '2026-11-02T10:06:00Z', { source_turn_id: 's1', origin: 'scheduled', outcome: 'work', duration_ms: 60_000, started_at: '2026-11-02T10:04:00Z' }),
    act(BUILDER, 'turn.completed', '2026-11-02T11:05:00Z', { source_turn_id: 's2', origin: 'scheduled', outcome: 'idle', duration_ms: 5_000 }),
    act(BUILDER, 'turn.completed', '2026-11-02T12:05:00Z', { source_turn_id: 's3', origin: 'directed', outcome: 'idle', duration_ms: 5_000 }),
    act(BUILDER, 'turn.completed', '2026-11-02T13:05:00Z', { source_turn_id: 's4', origin: 'scheduled', outcome: 'work', duration_ms: 5_000, run_id: 'run-1' }),
  ];
  const fallback = runsFromTurns(turns);
  check('turns as runs: dedupe, skip quiet scheduled checks and turns that name a run', fallback.length === 2, fallback.map((r) => r.outcome));

  // The feed already holds run-1 and the turn s1 (which names no run). The
  // window's turns ride along in activities: they must not add runs.
  const feed: RunRow[] = [
    run({ agentId: BUILDER, startedAt: '2026-11-02T13:00:00Z', durationMs: 10 * 60_000, title: 'run-1' }),
    run({ agentId: BUILDER, startedAt: '2026-11-02T10:04:00Z', durationMs: 60_000, source: 'turn', outcome: 'work' }),
  ];
  const combined = buildAgentAnalytics(base({ runs: feed, activities: turns }));
  check('feed rows are the runs; turns in the events add none', combined.totals.sums.run === 2, combined.totals.sums.run);
  check('busy time comes from the feed rows only', combined.totals.sums.busyMs === 11 * 60_000, combined.totals.sums.busyMs);
}

// ── Tile selection ─────────────────────────────────────────────────────
{
  const states = tileStates(model.totals.sums, model.money);
  const shown = arrangeTiles(states, { expanded: false });
  check('collapsed tiles have data', shown.shown.every((k) => states.find((t) => t.key === k)?.hasData));
  check('collapsed tiles cap at the default', shown.shown.length <= DEFAULT_TILE_CAP);
  check('More stats counts the rest', shown.more === states.length - shown.shown.length);
  const expanded = arrangeTiles(states, { expanded: true });
  check('expanded shows every tile in order', JSON.stringify(expanded.shown) === JSON.stringify(states.map((t) => t.key)) && expanded.more === 0);
  check('an empty window shows no tiles and offers them all', (() => {
    const empty = buildAgentAnalytics(base());
    const a = arrangeTiles(empty.tiles, { expanded: false });
    return a.shown.length === 0 && a.more === empty.tiles.length && empty.money.show === false;
  })());
  check('a picked tile that shows stays picked', resolveSelectedMetric(['runs', 'busy', 'tokens'], 'busy') === 'busy');
  check('a picked tile that no longer shows falls back to the first', resolveSelectedMetric(['runs', 'busy'], 'revenue') === 'runs');
  check('nothing picked takes the first', resolveSelectedMetric(['tasks', 'prs'], null) === 'tasks');
  check('no tiles, no selection', resolveSelectedMetric([], 'runs') === null);
  const many = METRIC_KEYS.map((key) => ({ key, hasData: true }));
  check('more than the cap with data: the first eight, the rest under More stats',
    arrangeTiles(many, { expanded: false }).shown.length === 8 && arrangeTiles(many, { expanded: false }).more === 4);
}

// ── Ranking for a hundred agents ───────────────────────────────────────
{
  const facts: Fact[] = Array.from({ length: 100 }, (_, i) => ({
    kind: 'run' as const, agentId: `agent-${i}`, projectId: null, model: null, provider: null, dateKey: '2026-11-02', value: i + 1,
  }));
  const rows = breakdown(facts, 'agent', { agentName: (id) => id.replace('agent-', 'Agent '), projectName: (id) => id, roleOf: () => null });
  const top = rankRows(rows, 'runs' as MetricKey, { limit: 10 });
  check('ranked by the metric, biggest first', top.rows[0].key === 'agent-99' && top.rows.length === 10 && top.more === 90);
  const searched = rankRows(rows, 'runs', { search: 'agent 4', limit: 10 });
  check('search narrows before the window', searched.matched === 11 && searched.rows[0].key === 'agent-49');
  check('ranked rows still add up to the total', rows.reduce((s, r) => s + r.group.sums.run, 0) === groupOf(facts).sums.run);
}

// ── Repeats ────────────────────────────────────────────────────────────
{
  const at = (m: number) => ({ k: 'x', at: m * 60_000 });
  const chains = collapseRepeats([at(0), at(50), at(100), at(400)], (i) => i.k, (i) => i.at);
  check('a chain of repeats each within the hour is one; a later one is new', chains.length === 2);
}


// ── Profit under a project filter excludes usage with no project ───────
{
  const input = base({
    timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')],
    activities: [
      act(BUILDER, 'usage.recorded', '2026-11-02T10:00:00Z', { source_usage_id: 'np1', model: 'm', input_tokens: 100, output_tokens: 10, cached_tokens: 0, cost_usd: 2 }),
      act(BUILDER, 'usage.recorded', '2026-11-02T11:00:00Z', { source_usage_id: 'np2', model: 'm', input_tokens: 50, output_tokens: 5, cached_tokens: 0, cost_usd: 0 }),
      act(BUILDER, 'usage.recorded', '2026-11-02T12:00:00Z', { source_usage_id: 'sp1', model: 'm', input_tokens: 10, output_tokens: 1, cached_tokens: 0, cost_usd: 0.5 }, SITE),
    ],
  });
  const whole = buildAgentAnalytics(input);
  check('unfiltered: nothing is excluded', whole.excludedNoProject.costUsd === 0 && profitCaveat(whole.excludedNoProject, money) === null);
  const site = buildAgentAnalytics({ ...input, selectedProjectIds: new Set([SITE]) });
  check('filtered: the no-project cost profit cannot carry is named', site.excludedNoProject.costUsd === 2 && site.excludedNoProject.unpricedTokens === 55, site.excludedNoProject);
  check('filtered: profit is revenue minus only the project\'s own cost', Math.abs(metricValue('profit', site.totals.sums) - (200 - 0.5)) < 1e-9);
  check('the caveat names the excluded amount', profitCaveat(site.excludedNoProject, money) === 'Excludes $2.00 usage with no project, plus unpriced usage not assignable');
  check('unpriced no-project usage is not assignable', profitCaveat({ costUsd: 0, unpricedTokens: 10 }, money) === 'Unpriced usage with no project not assignable');
}

// ── The analytics window: usage summed per hour is not split by model ──
{
  const payload: AnalyticsWindowPayload = {
    turns: [
      // [id, agent, created_at, source_turn_id, origin, duration_ms, started_at, outcome, outcome_source, job_name, trigger, session_id, model, tokens_scope, tokens]
      ['t-1', BUILDER, '2026-11-02T10:05:00+00:00', 'st1', 'scheduled', 60_000, '2026-11-02T10:04:00Z', 'work', null, 'pickup', 'schedule', null, 'm-run', 'turn', 1200],
      ['t-2', BUILDER, '2026-11-02T11:05:00+00:00', 'st2', 'scheduled', 5_000, '2026-11-02T11:05:00Z', 'idle', null, 'pickup', 'schedule', null, 'm-run', null, null],
    ],
    usage_hours: [
      // [agent, project, hour, input, output, cached, cost_usd, deltas]
      [REVIEWER, SITE, '2026-11-03T10:00:00+00:00', 1000, 100, 50, 0.75, 4],
      [REVIEWER, null, '2026-11-03T11:00:00+00:00', 300, 30, 0, 0, 2],
    ],
    session_usage: [],
    events: [],
  };
  const window = activitiesFromWindow(payload);
  const viaWindow = buildAgentAnalytics(base({ activities: window.rows, runs: runsFromTurns(window.rows) }));
  const byModel = breakdown(viaWindow.facts, 'model', { agentName: (id) => id, projectName: (id) => id, roleOf: () => null });
  const unsplit = byModel.find((r) => r.label === UNSPLIT_MODEL);
  check('window usage files under "Usage not split by model yet", never "Model not reported"',
    !!unsplit && !byModel.some((r) => r.label === 'Model not reported') && unsplit.group.sums.tokensIn === 1300, byModel.map((r) => r.label));
  check('a priced hour reads priced or mixed, never fully priced',
    costLabel(groupOf(viaWindow.facts.filter((f) => f.dateKey === '2026-11-03' && f.projectId === SITE)).sums).kind === 'mixed');
  check('mixed reads with its label', costText({ kind: 'mixed', usd: 0.75 }, money) === `$0.75 ${MIXED_LABEL}`);
  check('a run through the window shape counts once; the idle check does not', viaWindow.totals.sums.run === 1 && viaWindow.totals.sums.busyMs === 60_000, viaWindow.totals.sums);
  check('the window run keeps its model', byModel.find((r) => r.label === 'm-run')?.group.sums.run === 1);
}

// ── Runs that report no tokens ─────────────────────────────────────────
{
  const m = buildAgentAnalytics(base({
    runs: [
      run({ agentId: BUILDER, startedAt: '2026-11-02T10:00:00Z', durationMs: 1000 }),
      run({ agentId: BUILDER, startedAt: '2026-11-02T11:00:00Z', durationMs: 1000, tokensIn: 5, tokensOut: 1 }),
      run({ agentId: BUILDER, startedAt: '2026-11-02T12:00:00Z', durationMs: 1000, source: 'turn', outcome: 'work' }),
      run({ agentId: REVIEWER, startedAt: '2026-11-02T10:00:00Z', durationMs: 1000 }),
    ],
    activities: [act(REVIEWER, 'usage.recorded', '2026-11-02T10:00:00Z', { source_usage_id: 'r1', model: 'm', input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_usd: 0 })],
  }));
  check('a stored run with no tokens is counted; a ledger agent\'s and a turn are not', m.totals.sums.runsNoTokens === 1, m.totals.sums.runsNoTokens);
}

// ── Row access ─────────────────────────────────────────────────────────
check('questions always say they are limited to what you can open', scopeNotes({ projectsReadAll: true, timeReadAll: true }).questions === SCOPE_QUESTIONS);
check('tasks say so without projects.read_all', scopeNotes({ projectsReadAll: false, timeReadAll: true }).tasks === SCOPE_TASKS
  && scopeNotes({ projectsReadAll: true, timeReadAll: true }).tasks === null);
check('revenue says so without time.read_all', scopeNotes({ projectsReadAll: true, timeReadAll: false }).revenue === SCOPE_TIME
  && scopeNotes({ projectsReadAll: true, timeReadAll: true }).revenue === null);

// ── Run feed failed: no run figures ────────────────────────────────────
{
  const failed = buildAgentAnalytics(base({ runsAvailable: false, timeEntries: [entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z')] }));
  check('a failed run read leaves out every run tile', !failed.tiles.some((t) => RUN_METRICS.includes(t.key)) && failed.runsAvailable === false);
  check('a failed run read keeps the other tiles', failed.tiles.some((t) => t.key === 'tasks'));
}

// ── Keyset paging: a row written between pages never repeats ───────────
{
  type R = { at: string; id: string };
  const rowsAt = (n: number): R[] => Array.from({ length: n }, (_, i) => ({ at: `2026-11-02T10:${String(59 - i).padStart(2, '0')}:00Z`, id: `r${String(i).padStart(2, '0')}` }));
  let table: R[] = rowsAt(5);
  const ordered = () => table.slice().sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  let calls = 0;
  const insertAfterFirst = () => {
    calls += 1;
    if (calls === 2) table = [...table, { at: '2026-11-02T11:00:00Z', id: 'new' }];
  };
  void (async () => {
    // Keyset: rows strictly after the cursor.
    const keyset = await keysetPages<R>(async (after: PageCursor | null, limit) => {
      insertAfterFirst();
      const all = ordered();
      const from = after ? all.filter((r) => r.at < after.at || (r.at === after.at && r.id < after.id)) : all;
      return from.slice(0, limit);
    }, (r) => ({ at: r.at, id: r.id }), (r) => r.id, { pageSize: 2, cap: 100 });
    check('keyset paging returns each row once when a row lands between pages',
      keyset.rows.length === 5 && new Set(keyset.rows.map((r) => r.id)).size === 5, keyset.rows.map((r) => r.id));
    // Offset paging over the same source repeats a row: what keyset avoids.
    table = rowsAt(5); calls = 0;
    const offsetRows: R[] = [];
    for (let offset = 0; ; offset += 2) {
      insertAfterFirst();
      const page = ordered().slice(offset, offset + 2);
      offsetRows.push(...page);
      if (page.length < 2) break;
    }
    check('offset paging would have repeated a row (the case keyset fixes)', new Set(offsetRows.map((r) => r.id)).size < offsetRows.length);
    // Dedupe holds even if a source repeats a row.
    const repeated = await keysetPages<R>(async (after) => (after ? [] : [{ at: 'a', id: 'x' }, { at: 'a', id: 'x' }]), (r) => ({ at: r.at, id: r.id }), (r) => r.id, { pageSize: 5, cap: 10 });
    check('rows are deduped by key', repeated.rows.length === 1);
    finish();
  })();
}

// ── Busy time under a project filter stands on its own ─────────────────
{
  const input = base({
    runs: [
      run({ agentId: BUILDER, projectId: SITE, startedAt: '2026-11-02T10:00:00Z', durationMs: 60 * 60_000 }),
      // Wholly inside the SITE run: unfiltered it adds nothing to the union.
      run({ agentId: BUILDER, projectId: APP, startedAt: '2026-11-02T10:15:00Z', durationMs: 30 * 60_000 }),
    ],
  });
  const whole = buildAgentAnalytics(input);
  const rows = breakdown(whole.facts, 'project', { agentName: (id) => id, projectName: (id) => id, roleOf: () => null });
  check('unfiltered: project rows split the union (APP inside SITE gets 0)',
    whole.totals.sums.busyMs === 60 * 60_000 && (rows.find((r) => r.key === APP)?.group.sums.busyMs ?? 0) === 0);
  const app = buildAgentAnalytics({ ...input, selectedProjectIds: new Set([APP]) });
  check('filtered to APP: its run keeps its own 30 minutes, never 0', app.totals.sums.busyMs === 30 * 60_000, app.totals.sums.busyMs);
  const both = buildAgentAnalytics({ ...input, selectedProjectIds: new Set([APP, SITE]) });
  check('filtered to both: overlaps inside the selection still count once', both.totals.sums.busyMs === 60 * 60_000);
}

// ── A viewer in another zone: day keys follow it ───────────────────────
{
  const phoenix = (over: Partial<AgentAnalyticsInput>) => base({ timezone: 'America/Phoenix', ...over });
  // 06:30 UTC on Nov 3 is 11:30 pm on Nov 2 in Phoenix (UTC-7).
  const late = {
    runs: [run({ agentId: BUILDER, startedAt: '2026-11-03T06:30:00Z', durationMs: 10 * 60_000 })],
    tasks: [{ id: 'late', project_id: SITE, completed_at: '2026-11-03T06:30:00Z', claimed_by: BUILDER, assignee_ids: [] }],
  };
  const inRange = buildAgentAnalytics(phoenix({ ...late, range: { startKey: '2026-11-01', endKey: '2026-11-02' } }));
  check('an 11:30 pm run and task count on that local day', inRange.totals.sums.run === 1 && inRange.totals.sums.taskDone === 1);
  check('and sit on that day\'s bar', dailyByAgent(inRange.facts, 'runs', rangeDays({ startKey: '2026-11-01', endKey: '2026-11-02' }))[1].total === 1);
  const nextDay = buildAgentAnalytics(phoenix({ ...late, range: { startKey: '2026-11-03', endKey: '2026-11-07' } }));
  check('the UTC day after is not theirs', nextDay.totals.sums.run === 0 && nextDay.totals.sums.taskDone === 0);
}

// ── Incidents from host failure records ────────────────────────────────
{
  const fails = buildAgentAnalytics(base({
    activities: [
      act(BUILDER, 'turn.failed', '2026-11-02T10:00:00Z', { source_turn_id: 'f1', failure: 'failed', job_name: 'pickup', finished_at: '2026-11-02T10:00:00Z' }),
      act(BUILDER, 'turn.failed', '2026-11-02T10:01:00Z', { source_turn_id: 'f1', failure: 'failed', job_name: 'pickup', finished_at: '2026-11-02T10:00:00Z' }),
      act(BUILDER, 'turn.failed', '2026-11-04T10:00:00Z', { source_turn_id: 'f2', failure: 'dead', job_name: 'sweep', finished_at: '2026-11-04T10:00:00Z' }),
    ],
  }));
  check('a turn.failed record is an incident; the same fire twice counts once', fails.totals.sums.incident === 2, fails.totals.sums.incident);

  // A chain that began before the range counts once, on its first part in range.
  const crossing = buildAgentAnalytics(base({
    activities: [
      act(BUILDER, 'turn.failed', '2026-10-31T23:30:00Z', { source_turn_id: 'c1', failure: 'failed', job_name: 'pickup', finished_at: '2026-10-31T23:30:00Z' }),
      act(BUILDER, 'turn.failed', '2026-11-01T00:20:00Z', { source_turn_id: 'c2', failure: 'failed', job_name: 'pickup', finished_at: '2026-11-01T00:20:00Z' }),
      act(BUILDER, 'turn.failed', '2026-11-01T01:10:00Z', { source_turn_id: 'c3', failure: 'failed', job_name: 'pickup', finished_at: '2026-11-01T01:10:00Z' }),
      // A chain wholly before the range is not counted.
      act(BUILDER, 'turn.failed', '2026-10-30T10:00:00Z', { source_turn_id: 'o1', failure: 'dead', job_name: 'audit', finished_at: '2026-10-30T10:00:00Z' }),
    ],
  }));
  check('an incident chain crossing the range start counts once, on its first day in range',
    crossing.totals.sums.incident === 1 && crossing.facts.find((f) => f.kind === 'incident')?.dateKey === '2026-11-01', crossing.facts.filter((f) => f.kind === 'incident'));
}

// ── Revenue matches Finances on the same entries ───────────────────────
{
  const team = [
    { id: BUILDER, name: 'Builder', role: 'agent' },
    { id: REVIEWER, name: 'Reviewer', role: 'agent' },
    { id: HELPER, name: 'Helper', role: 'agent' },
  ] as TeamMember[];
  const projects = [
    { id: SITE, name: 'Site', hourly_tracking: true, hourly_rate: 100 },
    { id: APP, name: 'App', hourly_tracking: true, hourly_rate: 80 },
  ] as Project[];
  const entries = [
    entry(BUILDER, SITE, '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', { billing_multiplier: 1.5 }),
    // Crosses the range end: only the in-range part counts.
    // Thirty hours, so it crosses local midnight on Nov 7 in any zone.
    entry(REVIEWER, APP, '2026-11-07T12:00:00Z', '2026-11-08T18:00:00Z', { hourly_rate: 90 }),
    entry(HELPER, SITE, '2026-11-03T10:00:00Z', '2026-11-03T12:00:00Z', { approval_status: 'pending' }),
    entry(HELPER, SITE, '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z', { approval_status: 'rejected' }),
    entry(BUILDER, SITE, '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z', { billing_multiplier: 2, billing_converted_at: '2026-11-05T12:00:00Z' }),
  ];
  const ours = buildAgentAnalytics(base({ projects, timeEntries: entries }));
  const theirs = computeFinanceAttribution({
    projects, invoices: [], timeEntries: entries, team, now: NOW, range, timezone: TZ,
    rateByProject: new Map(projects.map((p) => [p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0])),
  });
  const byAgent = breakdown(ours.facts, 'agent', { agentName: (id) => id, projectName: (id) => id, roleOf: () => null });
  for (const member of team) {
    const row = theirs.rows.find((r) => r.memberId === member.id);
    const mine = byAgent.find((r) => r.key === member.id)?.group.sums;
    check(`${member.name}: revenue matches Finances`, Math.abs((mine?.revenue ?? 0) - (row?.grossRevenue ?? 0)) < 1e-6, { mine: mine?.revenue, theirs: row?.grossRevenue });
    check(`${member.name}: approved hours match Finances`, Math.abs((mine?.billableHours ?? 0) - (row?.hours ?? 0)) < 1e-6, { mine: mine?.billableHours, theirs: row?.hours });
  }
  const reviewerHours = byAgent.find((r) => r.key === REVIEWER)?.group.sums.billableHours ?? 0;
  check('an entry crossing the range end counts only its part in range', reviewerHours > 0 && reviewerHours < 30, reviewerHours);
  check('pending and rejected time is not revenue', (byAgent.find((r) => r.key === HELPER)?.group.sums.revenue ?? 0) === 0
    && (byAgent.find((r) => r.key === HELPER)?.group.sums.pendingRevenue ?? 0) === 300);
}

function finish() {
if (failures.length) {
  console.error(`verify-agent-analytics: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`verify-agent-analytics: ${passed} checks passed`);
}
