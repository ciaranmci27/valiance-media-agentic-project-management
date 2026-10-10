/**
 * The honest Agent Analytics read model (src/lib/agent-telemetry-analytics.ts),
 * with hand-built telemetry and exact expected numbers.
 *
 * Covers: effective runtime is outcome work only (minus rework on approved
 * work); unlabelled turns are never work or idle; directed turns are work;
 * lines sum to active runtime and overlap is counted once; failed fires add
 * runtime once (never for completed_with_error); a waiting turn.outcome row
 * still labels its turn; token attribution (scheduled turn tokens, directed
 * windows of [start, finish + 3 min], each delta once, idle share); overlap
 * detection; nearest-rank percentiles; attention, quality, billing gaps and
 * evals.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-telemetry-analytics.ts
 */
import { computeTelemetryAnalytics, percentile, sweep } from '../src/lib/agent-telemetry-analytics';
import type { AgentActivity, TeamMember } from '../src/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

const MIN = 60_000;
const JEFF = '00000000-0000-4000-8000-000000000001';
const JOHN = '00000000-0000-4000-8000-000000000002';
const GREG = '00000000-0000-4000-8000-000000000003';
const TASK = '00000000-0000-4000-8000-0000000000aa';
const TASK2 = '00000000-0000-4000-8000-0000000000bb';
const team = [
  { id: JEFF, name: 'Jeff', role: 'agent' },
  { id: JOHN, name: 'John', role: 'agent' },
  { id: GREG, name: 'Greg', role: 'agent' },
] as TeamMember[];
const range = { startKey: '2026-10-01', endKey: '2026-10-07' };
const at = (hhmm: string, day = '2026-10-03') => `${day}T${hhmm}:00.000Z`;
const ms = (iso: string) => Date.parse(iso);

let seq = 0;
function act(agent: string, type: string, metadata: Record<string, unknown>, created = at('12:00'), project: string | null = null): AgentActivity {
  seq += 1;
  return {
    id: `a${seq}`, agent_id: agent, project_id: project, activity_type: type, title: type, description: '',
    reference_type: null, reference_id: null, metadata, created_at: created,
  };
}
function turn(agent: string, id: string, start: string, minutes: number, extra: Record<string, unknown> = {}) {
  return act(agent, 'turn.completed', {
    source_turn_id: id, origin: 'scheduled', duration_ms: minutes * MIN, started_at: start,
    finished_at: new Date(ms(start) + minutes * MIN).toISOString(), ...extra,
  }, new Date(ms(start) + minutes * MIN + MIN).toISOString());
}

// -- percentiles and the sweep, alone ---------------------------------------
check('p50 of 1..4 is 2 (nearest rank)', percentile([4, 1, 3, 2], 0.5) === 2);
check('p95 of 1..20 is 19', percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95) === 19);
check('p95 of one sample is that sample', percentile([7], 0.95) === 7);
check('percentile of nothing is null, not zero', percentile([], 0.5) === null);
const swept = sweep([
  { start: 0, end: 10, line: 'idle' },
  { start: 5, end: 15, line: 'work' },
]);
check('sweep gives overlap to the higher line', JSON.stringify(swept) === JSON.stringify([
  { start: 0, end: 5, line: 'idle' }, { start: 5, end: 15, line: 'work' },
]), swept);

// -- time accounting ----------------------------------------------------------
const activities: AgentActivity[] = [
  // Jeff: 10m work, 20m idle, 5m waiting, 4m blocked, 1m skipped, 6m unknown, 8m unlabelled.
  turn(JEFF, 'cron:1', at('01:00'), 10, { outcome: 'work', job_name: 'Work', trigger: 'direct', tokens_scope: 'turn', tokens: { input: 1000, output: 100, cache_read: 2000, cache_write: 0, reasoning: 50 } }),
  turn(JEFF, 'cron:2', at('02:00'), 20, { outcome: 'idle', job_name: 'Work', trigger: 'schedule', tokens_scope: 'turn', tokens: { input: 23000, output: 0, cache_read: 41000 } }),
  turn(JEFF, 'cron:3', at('03:00'), 5, { outcome: 'waiting', job_name: 'Work', trigger: 'schedule' }),
  turn(JEFF, 'cron:4', at('04:00'), 4, { outcome: 'blocked', job_name: 'Work', trigger: 'schedule' }),
  turn(JEFF, 'cron:5', at('05:00'), 1, { outcome: 'skipped', job_name: 'Review', trigger: 'schedule' }),
  turn(JEFF, 'cron:6', at('06:00'), 6, { outcome: 'unknown', job_name: 'Work', trigger: 'schedule' }),
  turn(JEFF, 'cron:7', at('07:00'), 8),
  // A directed turn from before outcomes existed: still work. 12:00-12:30.
  act(JEFF, 'turn.completed', { source_turn_id: 'msg:s9:1', origin: 'directed', duration_ms: 30 * MIN, started_at: at('12:00'), finished_at: at('12:30'), session_id: 's9', model: 'gpt-5.5-codex', tokens_scope: 'session_usage' }, at('12:31')),
  // Its session's usage: inside, at finish + 2m (inside the grace), at + 4m (outside).
  act(JEFF, 'usage.recorded', { source_usage_id: 'u1', session_id: 's9', model: 'm', input_tokens: 500, output_tokens: 50, cached_tokens: 450, cost_usd: 0, recorded_at: at('12:10') }),
  act(JEFF, 'usage.recorded', { source_usage_id: 'u2', session_id: 's9', model: 'm', input_tokens: 100, output_tokens: 0, cached_tokens: 0, cost_usd: 0, recorded_at: at('12:32') }),
  act(JEFF, 'usage.recorded', { source_usage_id: 'u3', session_id: 's9', model: 'm', input_tokens: 7000, output_tokens: 0, cached_tokens: 0, cost_usd: 0, recorded_at: at('12:34') }),
  // Overlap: a directed work turn 13:00-13:20 and an idle scheduled turn 13:10-13:40.
  act(JEFF, 'turn.completed', { source_turn_id: 'msg:s10:1', origin: 'directed', duration_ms: 20 * MIN, started_at: at('13:00'), finished_at: at('13:20'), outcome: 'work' }, at('13:21')),
  turn(JEFF, 'cron:8', at('13:10'), 30, { outcome: 'idle', job_name: 'Work', trigger: 'schedule' }),
  // Failures: dead (2m of real runtime), completed_with_error (already on a
  // turn: not counted again), unknown (no real finish: no runtime).
  act(JEFF, 'turn.failed', { source_turn_id: 'cron:f1', failure: 'dead', has_completed_turn: false, started_at: at('15:00'), finished_at: at('15:02'), duration_ms: 2 * MIN, job_name: 'Work', error: 'process gone' }),
  act(JEFF, 'turn.failed', { source_turn_id: 'cron:1', failure: 'completed_with_error', has_completed_turn: true, started_at: at('01:00'), finished_at: at('01:10'), duration_ms: 10 * MIN, job_name: 'Work', error: 'tool error' }),
  act(JEFF, 'turn.failed', { source_turn_id: 'cron:f3', failure: 'unknown', has_completed_turn: false, started_at: at('16:00'), job_name: 'Work' }),
  // A label stored as its own row (its turn arrived later): folds onto cron:9.
  act(JEFF, 'turn.outcome', { source_turn_id: 'cron:9', outcome: 'idle', job_name: 'Work', trigger: 'schedule' }),
  turn(JEFF, 'cron:9', at('17:00'), 3),
  // Outside the range: ignored.
  turn(JEFF, 'cron:old', at('01:00', '2026-09-20'), 60, { outcome: 'work' }),
];

const data = computeTelemetryAnalytics({ activities, team, range, timezone: 'UTC', ledgerTokensByAgent: new Map([[JEFF, 99_999], [JOHN, null], [GREG, null]]), mergedPrsByAgent: new Map([[JEFF, 3]]) });
const jeff = data.perAgent.find((row) => row.agentId === JEFF)!.accounting;
const L = jeff.lines;
// Work: 10 (cron:1) + 30 (directed old) + 20 (directed 13:00-13:20) = 60.
check('work is outcome work and directed turns', L.work === 60 * MIN, L.work / MIN);
// Idle: 20 (cron:2) + 20 (13:20-13:40 of cron:8; 13:10-13:20 belongs to work) + 3 (cron:9 via its label).
check('idle counts each minute once, overlap to work', L.idle === 43 * MIN, L.idle / MIN);
check('waiting is its own line', L.waiting === 5 * MIN);
check('blocked is its own line', L.blocked === 4 * MIN);
check('skipped is its own line', L.skipped === 1 * MIN);
check('unknown is its own line', L.unknown === 6 * MIN);
check('an unlabelled turn is unlabelled, never work or idle', L.unlabelled === 8 * MIN);
check('failed runtime counts once (dead only)', L.failed === 2 * MIN, L.failed / MIN);
const sum = Object.values(L).reduce((a, b) => a + b, 0);
check('lines sum to active runtime', sum === jeff.activeMs, { sum: sum / MIN, active: jeff.activeMs / MIN });
check('active runtime is the union of turns plus real failed time', jeff.activeMs === (60 + 43 + 5 + 4 + 1 + 6 + 8 + 2) * MIN, jeff.activeMs / MIN);
check('effective runtime is work only', jeff.effectiveMs === 60 * MIN);
check('productive share is work over active', Math.abs((jeff.productiveShare ?? 0) - 60 / 129) < 1e-9, jeff.productiveShare);
check('the turn outside the range is ignored', !data.turns.some((t) => t.sourceTurnId === 'cron:old'));
check('a waiting label still labels its turn, marked backfilled', data.turns.find((t) => t.sourceTurnId === 'cron:9')?.outcome === 'idle'
  && data.turns.find((t) => t.sourceTurnId === 'cron:9')?.backfilled === true);
check('unlabelled turns are counted for the page', jeff.unlabelledTurns === 1 && jeff.unknownTurns === 1);

// By job and by trigger.
const work = data.byJob.find((row) => row.label === 'Work')!;
check('by job: Work job sums its turns', work.activeMs === (10 + 20 + 5 + 4 + 6 + 30 + 3) * MIN && work.workMs === 10 * MIN, work);
check('by job: directed turns are their own row', data.byJob.find((row) => row.key === 'directed')?.activeMs === 50 * MIN);
check('by job: an old turn without a job is named as such', data.byJob.some((row) => row.label === 'Job not recorded'));
check('by trigger: dispatcher wakes split from ticks', data.byTrigger.find((row) => row.key === 'direct')?.activeMs === 10 * MIN
  && data.byTrigger.find((row) => row.key === 'schedule')?.turns === 7, data.byTrigger);
check('by trigger: an old turn says its trigger was not recorded', data.byTrigger.find((row) => row.key === 'unrecorded')?.turns === 1);

// Daily stacks sum to the per-agent lines.
const dailyWork = data.daily.reduce((s, d) => s + d.lines.work, 0);
check('daily outcome stacks add up', dailyWork === L.work && data.daily.every((d) => d.dateKey === '2026-10-03'), data.daily.map((d) => d.dateKey));

// A turn across midnight splits between days.
const night = computeTelemetryAnalytics({
  activities: [turn(JOHN, 'cron:n', '2026-10-03T23:50:00.000Z', 20, { outcome: 'work' })],
  team, range, timezone: 'UTC',
});
check('a turn across midnight credits each day its share', night.daily.length === 2
  && night.daily[0].lines.work === 10 * MIN && night.daily[1].lines.work === 10 * MIN, night.daily);

// -- tokens -----------------------------------------------------------------
// cron:1 = 1000 + 100 + 2000 (reasoning not added); cron:2 = 64000; directed
// s9 = u1 (1000) + u2 (100), not u3 (outside finish + 3 min).
const byOutcome = Object.fromEntries(data.tokens.byOutcome.map((s) => [s.outcome, s.tokens]));
check('scheduled turn tokens attribute to their outcome', byOutcome.idle === 64_000, byOutcome);
check('work tokens: turn tokens plus the directed window', byOutcome.work === 3_100 + 1_100, byOutcome);
check('a delta after finish + 3 min is not attributed', data.tokens.attributedTokens === 64_000 + 4_200, data.tokens.attributedTokens);
check('idle-token share is idle + waiting + skipped over attributed', Math.abs((data.tokens.idleShare ?? 0) - 64_000 / 68_200) < 1e-9);
check('turn tokens never change the ledger total', data.tokens.ledgerTokens === 99_999);
const jeffTokens = data.tokens.perAgent.find((row) => row.agentId === JEFF)!;
check('tokens per merged PR divide the ledger by merges', jeffTokens.perMergedPr === 33_333);
check('no merges means no per-PR figure, not zero', data.tokens.perAgent.find((row) => row.agentId === JOHN)?.perMergedPr === null);

// A usage delta attributes to one directed turn only, even when windows overlap.
const twice = computeTelemetryAnalytics({
  activities: [
    act(GREG, 'turn.completed', { source_turn_id: 'msg:a', origin: 'directed', duration_ms: 10 * MIN, started_at: at('09:00'), finished_at: at('09:10'), session_id: 'sx' }),
    act(GREG, 'turn.completed', { source_turn_id: 'msg:b', origin: 'directed', duration_ms: 10 * MIN, started_at: at('09:11'), finished_at: at('09:21'), session_id: 'sx' }),
    act(GREG, 'usage.recorded', { source_usage_id: 'x1', session_id: 'sx', model: 'm', input_tokens: 10, output_tokens: 0, cached_tokens: 0, cost_usd: 0, recorded_at: at('09:12') }),
  ],
  team, range, timezone: 'UTC',
});
check('each usage delta attributes once', twice.tokens.attributedTokens === 10, twice.tokens);

// -- reliability --------------------------------------------------------------
const jeffOverlap = data.reliability.overlaps.find((row) => row.agentId === JEFF);
check('overlapping turns are found', jeffOverlap?.pairs === 1 && jeffOverlap.overlapMs === 10 * MIN, jeffOverlap);
check('turns that only touch do not overlap', !computeTelemetryAnalytics({
  activities: [turn(JOHN, 'cron:a', at('08:00'), 10, { outcome: 'work' }), turn(JOHN, 'cron:b', at('08:10'), 10, { outcome: 'work' })],
  team, range, timezone: 'UTC',
}).reliability.overlaps.length);
const workRate = data.reliability.failureRates.find((row) => row.jobName === 'Work')!;
// Work runs: 7 scheduled turns (cron:1,2,3,4,6,8,9) + 2 failures that never completed.
check('failure rate per job counts a completed_with_error once', workRate.failures === 3 && workRate.runs === 9, workRate);
check('the error list is newest first', data.reliability.failures[0].sourceTurnId === 'cron:f3', data.reliability.failures.map((f) => f.sourceTurnId));

const wakes = computeTelemetryAnalytics({
  activities: [5, 0, 30, 0, 120, 0, 0, 2, 9, 60].map((waited, i) => act(JOHN, 'dispatch.wake', { kind: 'state_change', at: at(`10:${String(i).padStart(2, '0')}`), waited_seconds: waited }))
    .concat([act(JOHN, 'dispatch.wake', { kind: 'yielded', at: at('11:00'), schedule_in_seconds: 40 })]),
  team, range, timezone: 'UTC',
});
check('hand-off latency p50 and p95', wakes.reliability.handoff.p50Seconds === 2 && wakes.reliability.handoff.p95Seconds === 120, wakes.reliability.handoff);
check('wake kinds are counted', wakes.reliability.wakes.stateChange === 10 && wakes.reliability.wakes.yielded === 1);
check('no wakes means no latency, not zero', data.reliability.handoff.p50Seconds === null && !data.reliability.tracked.wakes);

// -- attention ---------------------------------------------------------------
const attention = computeTelemetryAnalytics({
  activities: [
    act(JEFF, 'attention.message', { kind: 'telegram_reply', at: at('09:00'), solicited: true }),
    act(JEFF, 'attention.message', { kind: 'blocking_question', at: at('09:05'), solicited: false, task_id: TASK }),
    act(JEFF, 'attention.message', { kind: 'blocking_question', at: at('09:06', '2026-10-04'), solicited: false, task_id: TASK }),
    act(JEFF, 'attention.message', { kind: 'pm_notify', at: at('09:07'), solicited: false, task_id: TASK2 }),
    act(JEFF, 'blocked', { task_id: TASK, reason: 'needs a key' }, at('09:05')),
    act(JEFF, 'billing.resumed', { task_id: TASK }, at('10:05')),
    act(JEFF, 'blocked', { task_id: TASK2, reason: 'waiting' }, at('11:00')),
  ],
  fleetActivities: [{
    id: 'f1', agent_id: null, project_id: null, activity_type: 'attention.message', title: '', description: '',
    reference_type: null, reference_id: null, metadata: { kind: 'host_alert', at: at('08:00'), solicited: false, alert_key: 'api-down' }, created_at: at('08:01'),
  }],
  team, range, timezone: 'UTC',
}).attention;
const jeffAttention = attention.rows.find((row) => row.agentId === JEFF)!;
check('attention splits solicited and unsolicited', jeffAttention.solicited === 1 && jeffAttention.unsolicited === 3, jeffAttention);
check('attention counts by kind', jeffAttention.byKind.blocking_question === 2 && jeffAttention.byKind.pm_notify === 1);
check('unsolicited per day lands on the right days', jeffAttention.dailyUnsolicited[2] === 2 && jeffAttention.dailyUnsolicited[3] === 1, jeffAttention.dailyUnsolicited);
check('fleet alerts are their own row, last', attention.rows[attention.rows.length - 1].agentId === null && attention.rows[attention.rows.length - 1].name === 'Fleet');
check('host alert share', attention.hostAlertShare === 1 / 5);
check('blocking questions per task', attention.blockingByTask[0].taskId === TASK && attention.blockingByTask[0].count === 2);
check('blocked to resumed is measured, unresolved counted', attention.blockedToResume.samples === 1
  && attention.blockedToResume.medianMs === 60 * MIN && attention.blockedToResume.unresolved === 1, attention.blockedToResume);
check('no attention rows means not tracked', !data.attention.tracked);

// -- quality, billing gaps, evals, models ------------------------------------
const quality = computeTelemetryAnalytics({
  activities: [
    act(JOHN, 'review.verdict', { task_id: TASK, verdict: 'approved', round: 1 }),
    act(JOHN, 'review.verdict', { task_id: TASK2, verdict: 'changes_requested', round: 1 }),
    act(JOHN, 'review.verdict', { task_id: TASK2, verdict: 'approved', round: 2 }),
    act(JEFF, 'pr.merged', { pr_url: 'https://github.com/o/r/pull/1', additions: 1, deletions: 0, title: 'Add thing' }, at('10:00')),
    act(JEFF, 'pr.merged', { pr_url: 'https://github.com/o/r/pull/2', additions: 0, deletions: 1, title: 'Revert "Add thing"' }, at('11:00')),
  ],
  team, range, timezone: 'UTC', reopens: [{ task_id: TASK, project_id: null, reopened_at: at('12:00') }], reopenTrackingSince: '2026-10-02T00:00:00Z',
}).quality;
check('first-pass approval rate', quality.approvals === 2 && quality.firstPass === 1 && quality.firstPassRate === 0.5, quality);
check('review rounds per task', quality.roundsPerTask === 1.5);
check('reopened after done is counted', quality.reopened === 1);
check('a revert names its original, as a lower bound', quality.revertedAtLeast === 1 && quality.revertedPrs[0].prUrl.endsWith('/pull/1'), quality.revertedPrs);
check('without titles reverts are not tracked', data.quality.revertedAtLeast === null && !data.quality.revertTitlesReported && data.quality.reopened === null);
const noRevert = computeTelemetryAnalytics({
  activities: [act(JEFF, 'pr.merged', { pr_url: 'https://github.com/o/r/pull/9', additions: 1, deletions: 0, title: 'Add thing' })],
  team, range, timezone: 'UTC',
}).quality;
check('titled merges with no revert never claim zero reverts', noRevert.revertedAtLeast === null && noRevert.revertTitlesReported);

const gaps = computeTelemetryAnalytics({
  activities: [
    act(JEFF, 'billing.gap', { start: at('09:00'), end: at('09:05'), minutes: 5, phase: 'before_timer', source_turn_id: 'cron:1' }),
    act(JEFF, 'billing.gap', { start: at('10:00'), end: at('10:03'), minutes: 3, phase: 'mid_turn', source_turn_id: 'cron:2', task_id: TASK }),
    act(JEFF, 'billing.gap', { start: at('11:00'), end: at('11:09'), minutes: 9, phase: 'mid_turn', source_turn_id: 'cron:3' }),
  ],
  team, range, timezone: 'UTC',
  gapReviews: [{ activity_id: `a${seq}`, status: 'dismissed', note: 'setup', reviewed_at: at('12:00') }],
}).billingGaps;
check('open mid-turn gaps come first, reviewed last', gaps[0].phase === 'mid_turn' && !gaps[0].review
  && gaps[1].phase === 'before_timer' && gaps[2].review?.status === 'dismissed', gaps.map((g) => [g.phase, g.review?.status]));

const evals = computeTelemetryAnalytics({
  activities: [
    act(GREG, 'eval.result', { suite: 'alex', score: 18, total: 20, complete: true, model: 'm1', started_at: '20261002T100000Z' }),
    act(GREG, 'eval.result', { suite: 'alex', score: 5, total: 6, complete: false, model: 'm2', started_at: '20261003T100000Z', failed_cases: ['c1', null] }),
  ],
  team, range, timezone: 'UTC',
}).evals;
check('eval points per suite, in time order, with their model', evals[0].points.length === 2 && evals[0].points[0].model === 'm1'
  && evals[0].points[1].complete === false && evals[0].points[1].failedCases.length === 1, evals);
check('model runs per agent', data.models.find((row) => row.agentId === JEFF)?.runs[0].model === 'gpt-5.5-codex');

// -- review fixes ------------------------------------------------------------
check('failed fires: all three counted, two without a turn', jeff.failedRuns === 3 && jeff.failedWithoutTurn === 2, jeff);

// Rework: only real work on an approved task counts, never host records or
// the merge-and-close that follows an approval.
const reworkCase = (extra: AgentActivity[]) => computeTelemetryAnalytics({
  activities: [
    act(JOHN, 'review.verdict', { task_id: TASK, verdict: 'approved', round: 1 }, at('09:00', '2026-10-02')),
    turn(JEFF, 'cron:rw', at('12:00'), 30, { outcome: 'work' }),
    ...extra,
  ],
  team, range, timezone: 'UTC',
}).perAgent.find((row) => row.agentId === JEFF)!.accounting.lines;
const hostOnly = reworkCase([
  act(JEFF, 'billing.gap', { start: at('12:05'), end: at('12:09'), minutes: 4, phase: 'mid_turn', source_turn_id: 'cron:rw', task_id: TASK }, at('12:10')),
  act(JEFF, 'pr.merged', { task_id: TASK, pr_url: 'https://github.com/o/r/pull/5', additions: 1, deletions: 0 }, at('12:12')),
  act(JEFF, 'work.done', { task_id: TASK, task_title: 'Done' }, at('12:13')),
  act(JEFF, 'billing.stopped', { task_id: TASK }, at('12:14')),
]);
check('host records and finishing steps are not rework', hostOnly.work === 30 * MIN && hostOnly.rework === 0, hostOnly);
const realRework = reworkCase([act(JEFF, 'work.milestone', { task_id: TASK, kind: 'commit', detail: 'again' }, at('12:15'))]);
check('real work on an approved task is rework', realRework.rework === 30 * MIN && realRework.work === 0, realRework);

// First pass: a replacement PR approved at round 1 after a changes-requested
// cycle is not first pass.
const replaced = computeTelemetryAnalytics({
  activities: [
    act(JOHN, 'review.verdict', { task_id: TASK, verdict: 'changes_requested', round: 1, pr_url: 'https://github.com/o/r/pull/1' }, at('09:00')),
    act(JOHN, 'review.verdict', { task_id: TASK, verdict: 'approved', round: 1, pr_url: 'https://github.com/o/r/pull/2' }, at('11:00')),
  ],
  team, range, timezone: 'UTC',
}).quality;
check('a replacement PR after changes requested is not first pass', replaced.approvals === 1 && replaced.firstPass === 0, replaced);
check('rounds count per PR', replaced.reviewRounds === 2 && replaced.roundsPerTask === 2, replaced);

// Reopens: a range that ends before tracking began is not measured.
const early = computeTelemetryAnalytics({
  activities: [], team, range: { startKey: '2026-09-01', endKey: '2026-09-30' }, timezone: 'UTC',
  reopens: [], reopenTrackingSince: '2026-10-10T18:00:00Z',
}).quality;
check('reopens before tracking began are not a zero', early.reopened === null, early);
const noStart = computeTelemetryAnalytics({ activities: [], team, range, timezone: 'UTC', reopens: [], reopenTrackingSince: null }).quality;
check('reopens without a recorded start are not tracked', noStart.reopened === null);

// The breakdown counts only the part of a turn inside the range.
const edge = computeTelemetryAnalytics({
  activities: [turn(JOHN, 'cron:edge', '2026-10-07T23:30:00.000Z', 60, { outcome: 'work', job_name: 'Work' })],
  team, range, timezone: 'UTC',
});
check('the breakdown is clipped to the range like Time accounting', edge.byJob[0].activeMs === 30 * MIN && edge.fleet.activeMs === 30 * MIN, edge.byJob);
check('per-agent breakdown exists', edge.byAgent[0]?.label === 'John' && edge.byAgent[0].productiveShare === 1);

const gapFiltered = computeTelemetryAnalytics({
  activities: [act(JEFF, 'billing.gap', { start: at('09:00'), end: at('09:05'), minutes: 5, phase: 'mid_turn', source_turn_id: 'cron:1' })],
  team, range, timezone: 'UTC', selectedProjectIds: new Set(['p1']),
});
check('billing gaps are withheld under a project filter', gapFiltered.billingGaps.length === 0);

// A project filter withholds runtime instead of misattributing it.
const filtered = computeTelemetryAnalytics({ activities, team, range, timezone: 'UTC', selectedProjectIds: new Set(['p1']) });
check('runtime is withheld under a project filter', filtered.fleet.activeMs === 0 && filtered.turns.length === 0);

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
