/**
 * Agent Analytics in one round trip (20261011033458_agent_analytics_window.sql
 * plus src/lib/agent-analytics-window.ts) gives exactly the numbers the raw
 * rows give. A varied dataset (labelled, unlabelled and directed turns, turns
 * crossing midnight, usage deltas inside and outside directed windows, late
 * host records, a fleet alert, narrative events, odd payload values) is read
 * both ways from a pglite database behind the PostgREST stand-in, through the
 * real supabase-js rpc call, and every figure of both read models is compared
 * in two timezones. Also: the migration re-runs, and an unparseable payload
 * value cannot fail the report.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-analytics-window.ts
 */
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';
import type { AgentActivity, TeamMember } from '../src/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 800)}`);
}

const JEFF = '00000000-0000-4000-8000-000000000001';
const JOHN = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-0000000000aa';
const team = [
  { id: JEFF, name: 'Jeff', role: 'agent' },
  { id: JOHN, name: 'John', role: 'agent' },
] as TeamMember[];
const range = { startKey: '2026-10-01', endKey: '2026-10-07' };
const MIN = 60_000;

async function main() {
  const db = new PGlite();
  const agentSchema = (await readFile(new URL('../supabase/schema_ai_agent.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const table = agentSchema.match(/CREATE TABLE public\.agent_activities \([\s\S]*?^\);/m)?.[0];
  if (!table) throw new Error('agent_activities in schema_ai_agent.sql');
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO service_role, authenticated;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL);
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
    ${table}
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261011033458_agent_analytics_window.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run
  await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;');
  await db.query(`INSERT INTO team_members VALUES ($1, 'Jeff', 'agent'), ($2, 'John', 'agent')`, [JEFF, JOHN]);

  let seq = 0;
  const insert = async (agent: string | null, type: string, metadata: Record<string, unknown>, created: string, project: string | null = null) => {
    seq += 1;
    const id = `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    await db.query(
      `INSERT INTO agent_activities(id, agent_id, project_id, activity_type, title, reference_id, metadata, created_at, source_key)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
      [id, agent, project, type, typeof metadata.task_id === 'string' ? metadata.task_id : null, JSON.stringify(metadata), created,
        ['turn.failed', 'agent.restarted', 'attention.message', 'dispatch.wake', 'billing.gap', 'eval.result', 'turn.outcome'].includes(type) ? `k${seq}` : null],
    );
  };
  const turn = async (agent: string, id: string, startIso: string, minutes: number, extra: Record<string, unknown> = {}, createdIso?: string) => {
    const finish = new Date(Date.parse(startIso) + minutes * MIN).toISOString();
    await insert(agent, 'turn.completed', {
      source_turn_id: id, origin: 'scheduled', duration_ms: minutes * MIN, started_at: startIso, finished_at: finish, ...extra,
    }, createdIso ?? new Date(Date.parse(finish) + MIN).toISOString());
  };
  const usage = async (agent: string, id: string, at: string, tokens: [number, number, number], session?: string, cost = 0.01) =>
    insert(agent, 'usage.recorded', {
      source_usage_id: id, model: 'm', input_tokens: tokens[0], output_tokens: tokens[1], cached_tokens: tokens[2],
      cost_usd: cost, recorded_at: at, ...(session ? { session_id: session } : {}),
    }, new Date(Date.parse(at) + 90_000).toISOString());

  // Turns of every kind, across the range and its edges.
  for (let day = 1; day <= 7; day++) {
    const d = `2026-10-0${day}`;
    await turn(JEFF, `cron:a${day}`, `${d}T14:00:00.000Z`, 12, { outcome: day % 2 ? 'work' : 'idle', job_name: 'Work', trigger: 'schedule', model: 'gpt-a', tokens_scope: 'turn', tokens: { input: 1000 * day, output: 50, cache_read: 2000, cache_write: 0, reasoning: 9 } });
    await turn(JOHN, `cron:b${day}`, `${d}T15:00:00.000Z`, 5, { outcome: 'waiting', job_name: 'Review', trigger: 'direct', model: 'gpt-b', tokens_scope: 'turn', tokens: { input: 300 } });
    await usage(JEFF, `u-sched-${day}`, `${d}T14:13:30.000Z`, [1000 * day, 50, 2000], `cron_a${day}`);
  }
  await turn(JEFF, 'cron:old', '2026-10-03T06:00:00.000Z', 30); // unlabelled
  await turn(JEFF, 'cron:night', '2026-10-04T06:50:00.000Z', 20, { outcome: 'work', job_name: 'Work' }); // crosses Phoenix midnight
  await turn(JOHN, 'cron:edge', '2026-10-07T23:40:00.000Z', 40, { outcome: 'idle', job_name: 'Work' }); // crosses the range end (UTC)
  await turn(JOHN, 'cron:before', '2026-09-30T12:00:00.000Z', 10, { outcome: 'work' }); // before the range
  await turn(JEFF, 'cron:odd', '2026-10-05T09:00:00.000Z', 3, { outcome: 'idle', tokens_scope: 'turn', tokens: { input: 'lots' } }); // odd value
  // A reset turn reposted weeks later (created after the range, started in it).
  await turn(JOHN, 'cron:repost', '2026-10-06T10:00:00.000Z', 8, { outcome: 'work', job_name: 'Work' }, '2026-10-25T10:00:00.000Z');
  // Directed turns and their session usage, inside and outside the windows.
  await insert(JEFF, 'turn.completed', { source_turn_id: 'msg:s1:1', origin: 'directed', duration_ms: 30 * MIN, started_at: '2026-10-02T18:00:00.000Z', finished_at: '2026-10-02T18:30:00.000Z', session_id: 'tg1', model: 'gpt-a', tokens_scope: 'session_usage' }, '2026-10-02T18:31:00.000Z');
  await insert(JEFF, 'turn.completed', { source_turn_id: 'msg:s1:2', origin: 'directed', duration_ms: 10 * MIN, started_at: '2026-10-05T18:00:00.000Z', finished_at: '2026-10-05T18:10:00.000Z', session_id: 'tg1', outcome: 'work' }, '2026-10-05T18:11:00.000Z');
  await usage(JEFF, 'u-tg-1', '2026-10-02T18:10:00.000Z', [500, 40, 300], 'tg1');
  await usage(JEFF, 'u-tg-2', '2026-10-02T18:32:00.000Z', [100, 0, 0], 'tg1');
  await usage(JEFF, 'u-tg-3', '2026-10-02T18:40:00.000Z', [9000, 0, 0], 'tg1'); // after finish + 3 min
  await usage(JEFF, 'u-tg-4', '2026-10-05T18:05:00.000Z', [700, 10, 0], 'tg1');
  await usage(JOHN, 'u-proj', '2026-10-03T11:20:00.000Z', [400, 4, 0], undefined, 0.5);
  await insert(JOHN, 'usage.recorded', { source_usage_id: 'u-p2', model: 'm', input_tokens: 70, output_tokens: 1, cached_tokens: 0, cost_usd: 0.2, recorded_at: '2026-10-03T11:50:00.000Z' }, '2026-10-03T11:52:00.000Z', null);
  await usage(JOHN, 'u-out', '2026-09-20T11:20:00.000Z', [99999, 0, 0]); // outside the range
  // Narrative events.
  await insert(JOHN, 'review.verdict', { task_id: TASK, verdict: 'approved', round: 1, pr_url: 'https://github.com/o/r/pull/1' }, '2026-10-02T10:00:00.000Z');
  await insert(JEFF, 'work.handoff', { task_id: TASK, task_title: 'Ship', pr_url: 'https://github.com/o/r/pull/1' }, '2026-10-02T09:00:00.000Z');
  await insert(JEFF, 'pr.merged', { task_id: TASK, pr_url: 'https://github.com/o/r/pull/1', additions: 10, deletions: 2 }, '2026-10-02T11:00:00.000Z');
  await insert(JEFF, 'work.milestone', { task_id: TASK, kind: 'commit', detail: 'again' }, '2026-10-03T14:05:00.000Z'); // rework inside cron:a3
  await insert(JEFF, 'blocked', { task_id: TASK, reason: 'key' }, '2026-10-04T08:00:00.000Z');
  await insert(JEFF, 'billing.resumed', { task_id: TASK }, '2026-10-04T09:30:00.000Z');
  // Host records, some posted weeks late, and a fleet alert.
  await insert(JEFF, 'turn.failed', { source_turn_id: 'cron:f1', failure: 'dead', has_completed_turn: false, started_at: '2026-10-03T20:00:00.000Z', finished_at: '2026-10-03T20:04:00.000Z', duration_ms: 4 * MIN, job_name: 'Work', error: 'gone' }, '2026-10-03T20:20:00.000Z');
  await insert(JEFF, 'attention.message', { kind: 'blocking_question', at: '2026-10-04T08:00:00.000Z', solicited: false, task_id: TASK }, '2026-10-30T00:00:00.000Z');
  await insert(null, 'attention.message', { kind: 'host_alert', at: '2026-10-05T08:00:00.000Z', solicited: false, alert_key: 'api-down' }, '2026-10-05T08:01:00.000Z');
  await insert(JOHN, 'dispatch.wake', { kind: 'state_change', at: '2026-10-05T12:00:00.000Z', waited_seconds: 33 }, '2026-10-05T12:01:00.000Z');
  await insert(JOHN, 'agent.restarted', { kind: 'container', started_at: '2026-10-06T01:00:00.000Z', deploy_commit: 'abc1234' }, '2026-10-06T01:02:00.000Z');
  await insert(JEFF, 'billing.gap', { start: '2026-10-03T14:02:00.000Z', end: '2026-10-03T14:06:00.000Z', minutes: 4, phase: 'mid_turn', source_turn_id: 'cron:a3' }, '2026-10-20T00:00:00.000Z');
  await insert(JOHN, 'eval.result', { suite: 'alex', score: 18, total: 20, complete: true, model: 'gpt-b', started_at: '20261004T100000Z' }, '2026-10-04T10:30:00.000Z');

  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { fetchAgentAnalyticsWindow, fetchAgentActivityRange } = await import('../src/lib/supabase/queries');
    const { computeTelemetryAnalytics } = await import('../src/lib/agent-telemetry-analytics');
    const { computeAgentAnalytics, computePipelineLatency } = await import('../src/lib/agent-analytics');
    const supabase = getServiceClient();

    const raw = await fetchAgentActivityRange(supabase, range);
    const window = await fetchAgentAnalyticsWindow(supabase, range);
    check('the window call answers', window.rows.length > 0);
    check('usage arrives summed per hour, not per delta',
      window.rows.filter((r) => r.activity_type === 'usage.recorded').length < raw.rows.filter((r) => r.activity_type === 'usage.recorded').length);
    check('the payload is smaller than the raw rows', JSON.stringify(window).length < JSON.stringify(raw).length,
      { window: JSON.stringify(window).length, raw: JSON.stringify(raw).length });
    check('fleet alerts come back separately', window.fleet.length === 1 && raw.fleet.length === 1);

    for (const timezone of ['UTC', 'America/Phoenix']) {
      const telemetry = (rows: AgentActivity[], fleet: typeof raw.fleet, attribution?: typeof window.attribution) => {
        const delivery = computeAgentAnalytics({ activities: rows, timeEntries: [], team, projects: [], range, timezone, now: Date.parse('2026-10-10T00:00:00Z') });
        const t = computeTelemetryAnalytics({
          activities: rows, fleetActivities: fleet, team, range, timezone, attributionUsage: attribution,
          mergedPrsByAgent: new Map(delivery.agents.map((r) => [r.agentId, r.prsMerged])),
          ledgerTokensByAgent: new Map(delivery.agents.map((r) => [r.agentId, r.inputTokens.tracking === 'tracked' ? (r.inputTokens.value ?? 0) + (r.outputTokens.value ?? 0) + (r.cachedTokens.value ?? 0) : null])),
        });
        return {
          delivery: delivery.agents.map((r) => ({ ...r })),
          deliveryDaily: delivery.daily,
          latency: computePipelineLatency(rows, range, timezone),
          fleet: t.fleet, perAgent: t.perAgent, byJob: t.byJob, byTrigger: t.byTrigger, byAgent: t.byAgent, daily: t.daily,
          tokens: t.tokens, attention: t.attention, quality: t.quality,
          reliability: { ...t.reliability, failures: t.reliability.failures.map((f) => f.sourceTurnId), overlaps: t.reliability.overlaps.map((o) => [o.agentId, o.pairs, o.overlapMs]) },
          gaps: t.billingGaps.map((g) => [g.sourceTurnId, g.minutes, g.phase]),
          models: t.models, evals: t.evals.map((e) => e.points.map((p) => [p.suite, p.score, p.total, p.model])),
          // Row order is not a figure; every derived number above is order-free.
          turns: t.turns.map((x) => [x.sourceTurnId, x.outcome, x.durationMs, x.start, x.turnTokens, x.trigger, x.jobName])
            .sort((p, q) => String(p[0]).localeCompare(String(q[0]))),
        };
      };
      const a = telemetry(raw.rows, raw.fleet);
      const b = telemetry(window.rows, window.fleet, window.attribution);
      // The database sums money exactly (0.11) where JS float addition drifts
      // (0.10999999999999999); compare to the nanodollar.
      const stable = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e9) / 1e9 : v));
      for (const key of Object.keys(a) as (keyof typeof a)[]) {
        const same = stable(a[key]) === stable(b[key]);
        if (!same && process.env.DEBUG_WINDOW) {
          const ra = stable(a[key]); const rb = stable(b[key]);
          let i = 0; while (i < ra.length && ra[i] === rb[i]) i++;
          console.log(key, 'raw:', ra.slice(Math.max(0, i - 120), i + 120));
          console.log(key, 'win:', rb.slice(Math.max(0, i - 120), i + 120));
        }
        check(`${timezone}: ${key} is identical both ways`, same, { raw: a[key], window: b[key] });
      }
      // Sanity: the dataset actually exercises what it claims.
      if (timezone === 'UTC') {
        check('the dataset has rework, directed attribution and late rows', a.fleet.lines.rework > 0 && a.tokens.attributedTokens > 0
          && a.attention.total === 2 && a.gaps.length === 1 && a.turns.some((t) => t[0] === 'cron:repost'), { fleet: a.fleet.lines, tokens: a.tokens.attributedTokens, attention: a.attention.total });
        check('an unparseable token value counts as zero, not an error', a.turns.some((t) => t[0] === 'cron:odd' && t[4] === 0) && b.turns.some((t) => t[0] === 'cron:odd' && t[4] === 0));
      }
    }
  } finally {
    await server.close();
  }

  console.log(`analytics window: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
