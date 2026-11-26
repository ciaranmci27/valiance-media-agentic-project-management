/**
 * Agent runs (20261124000500_agent_runs.sql) through the real v1 API
 * (withApi, supabase-js, a fake PostgREST over PGlite), and over MCP:
 * - Start, update and finish: a run on a task takes its project; plan, notes
 *   (the newest kept), tokens and cost as totals; finish sets finished_at;
 *   finishing again with the same status answers the run, another is 409.
 * - Own-only writes: another agent's run is 404, listing it is 403, a
 *   person cannot start one, agents.manage starts, updates and lists any.
 * - external_id: a second start with it answers the same run (200), per
 *   agent; two agents may use the same id.
 * - Stale reads: a run running two hours past its last update reads
 *   timed_out (view, API, task), and any update brings it back.
 * - Waiting: an agent PATCHes its run to waiting (API and MCP); a note with
 *   status waiting keeps it, a supervisor's note leaves it, any other update
 *   from its agent brings it back to running; a question or approval with
 *   run_id holds it until answered; run_id must be the asker's own
 *   unfinished run (422 run_not_yours, 409 run_finished); a finish from
 *   waiting works.
 * - Turns: a turn.completed naming a run (run_id or run_external_id) is
 *   listed under it and keeps the run alive; one naming another agent's run,
 *   or none, reads as a finished run of its own; scheduled turns that did no
 *   work are not runs; a turn's tokens show only when they are its own.
 * - Analytics: the same turns and usage give the same totals whether or not
 *   they name a run, and every turn's tokens land in exactly one place.
 * - The task (GET /tasks/{id}, the brief) shows its latest run.
 * - Webhooks: run.started and run.finished once each, concerning the agent,
 *   in order; nothing for updates.
 * - The context pack lists the run tools and their convention.
 * - Row security: a member reads their own runs (agents.manage: all).
 * - The migration on the schema before it matches schema.sql and runs twice.
 *
 *   npm run -s test:agent-runs
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { AGENT_RUN_STALE_AFTER_SECONDS, effectiveRunStatus } from '../src/lib/agent-runs';

const MIGRATION = '20261124000500_agent_runs.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- RUNS (20261124000500_agent_runs.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const AGENT_SCOPES = ['tasks.read', 'agent_activity.write', 'projects.read', 'project_context.read', 'files.read'];

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  // Members with logins, so row security can be read as each of them.
  const member = async (name: string, role: string) => {
    const user = randomUUID();
    await q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('display_name', $3::text))",
      [user, `${name.toLowerCase()}@example.com`, name]);
    const id = (await q<{ id: string }>('UPDATE pm.team_members SET role = $2 WHERE auth_user_id = $1 RETURNING id', [user, role]))[0].id;
    return { id, user };
  };
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder', 'agent');
  const planner = await member('Planner', 'agent');
  const morgan = await member('Morgan', 'member');
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  for (const m of [builder.id, planner.id, morgan.id]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    builder: await key(builder.id, AGENT_SCOPES),
    planner: await key(planner.id, AGENT_SCOPES),
    morgan: await key(morgan.id, ['tasks.read', 'projects.read']),
    owner: await key(owner.id, ['agents.manage', 'tasks.read', 'projects.read']),
  };
  const task = async (title: string) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [apex, title]))[0].id;
    await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, builder.id]);
    return id;
  };
  return { q, owner, builder, planner, morgan, apex, keys, task };
}

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the runs section is there, last', at > 0 && banner > 0 && !SCHEMA_SQL.slice(at + SECTION.length).includes('\n-- ====\n-- '));
  check('schema.sql: the section mirrors the migration body',
    SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('CREATE TABLE IF NOT EXISTS pm.agent_runs')).trim()));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const agent = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent') RETURNING id")).rows[0].id;
  const turn = { source_turn_id: 't-old', origin: 'scheduled', duration_ms: 9000, started_at: '2026-11-20T10:00:00Z', finished_at: '2026-11-20T10:00:09Z', outcome: 'work' };
  await old.query(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'turn.completed', 'Ran 9s (scheduled)', $2)`, [agent, turn]);
  await applyMigrationsFrom(old, MIGRATION);
  const feed = (await old.query<Loose>('SELECT source, status, duration_ms, external_id FROM pm.agent_run_feed')).rows;
  check('upgrade: a turn recorded before reads as a finished run', feed.length === 1 && feed[0].source === 'turn' && feed[0].status === 'succeeded'
    && Number(feed[0].duration_ms) === 9000 && feed[0].external_id === 't-old', feed);
  // What the previous release does still works: it records turns the same way.
  await old.query(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'turn.completed', 'Ran 1s (directed)', $2)`,
    [agent, { ...turn, source_turn_id: 't-old-2', origin: 'directed' }]);
  check('upgrade: the previous release still records turns', (await old.query('SELECT 1 FROM pm.agent_activities')).rows.length === 2);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
}

async function main() {
  check('effectiveRunStatus: running within two hours is running', effectiveRunStatus({ status: 'running', updated_at: new Date(Date.now() - 60_000).toISOString() }) === 'running');
  check('effectiveRunStatus: running past two hours is timed_out',
    effectiveRunStatus({ status: 'running', updated_at: new Date(Date.now() - (AGENT_RUN_STALE_AFTER_SECONDS + 60) * 1000).toISOString() }) === 'timed_out');
  check('effectiveRunStatus: a finished run stays as it finished', effectiveRunStatus({ status: 'failed', updated_at: '2020-01-01T00:00:00Z' }) === 'failed');

  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const runsRoute = await import('../src/app/api/v1/agents/runs/route');
    const runRoute = await import('../src/app/api/v1/agents/runs/[id]/route');
    const finishRoute = await import('../src/app/api/v1/agents/runs/[id]/finish/route');
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const briefRoute = await import('../src/app/api/v1/tasks/[id]/brief/route');
    const myContextRoute = await import('../src/app/api/v1/agents/me/context/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const start = (apiKey: string, body: unknown) => call(runsRoute.POST, 'POST', '/api/v1/agents/runs', {}, apiKey, body);
    const list = (apiKey: string, query = '') => call(runsRoute.GET, 'GET', `/api/v1/agents/runs${query}`, {}, apiKey);
    const get = (apiKey: string, id: string) => call(runRoute.GET, 'GET', `/api/v1/agents/runs/${id}`, { id }, apiKey);
    const patch = (apiKey: string, id: string, body: unknown) => call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${id}`, { id }, apiKey, body);
    const finish = (apiKey: string, id: string, body?: unknown) => call(finishRoute.POST, 'POST', `/api/v1/agents/runs/${id}/finish`, { id }, apiKey, body);
    const postTurn = (apiKey: string, payload: Record<string, unknown>) =>
      call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, apiKey, { activity_type: 'turn.completed', payload });
    const runEvents = async (runId: string) => s.q<Loose>(
      "SELECT event_type, sequence, payload FROM pm.webhook_events WHERE resource_type = 'run' AND resource_id = $1 ORDER BY sequence", [runId]);

    // Endpoints: one for the builder's work, one for the planner's.
    const builderHook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id)
      VALUES ('Builder wake', 'https://hooks.example.test/builder', 'whsec_b', '{run.started,run.finished}', $1) RETURNING id`, [s.builder.id]))[0].id;
    const plannerHook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id)
      VALUES ('Planner wake', 'https://hooks.example.test/planner', 'whsec_p', '{run.started,run.finished}', $1) RETURNING id`, [s.planner.id]))[0].id;

    // --- Start ----------------------------------------------------------------------------------
    const checkout = await s.task('Fix the checkout total');
    const started = await start(s.keys.builder, {
      task_id: checkout, title: 'Fix the EU rounding', trigger: 'assigned', external_id: 'sess-1', model: 'claude-opus',
      external_url: 'https://smith.example.test/runs/sess-1', plan: [{ title: 'Reproduce' }, { title: 'Fix', status: 'pending' }],
    });
    const run1 = started.body.data;
    check('start: 201 with the run, running, on the task and its project', started.status === 201 && run1?.status === 'running' && run1.task_id === checkout
      && run1.project_id === s.apex && run1.agent_id === s.builder.id && run1.agent_name === 'Builder' && run1.source === 'run'
      && run1.plan?.length === 2 && run1.plan[0].status === 'pending' && run1.trigger === 'assigned' && run1.finished_at === null, started.body);
    check('start: no turns yet, tokens not reported (null, not zero)', run1?.turns?.count === 0 && run1.tokens_in === null && run1.cost_usd === null, run1);

    // --- external_id upsert ---------------------------------------------------------------------
    const again = await start(s.keys.builder, { external_id: 'sess-1', title: 'Fix the EU rounding, again' });
    check('external_id: starting again answers 200 with the same run, updated', again.status === 200 && again.body.data?.id === run1.id
      && again.body.data.title === 'Fix the EU rounding, again' && again.body.data.task_id === checkout, again.body);
    check('external_id: still one run for it', (await s.q('SELECT 1 FROM pm.agent_runs WHERE agent_id = $1 AND external_id = $2', [s.builder.id, 'sess-1'])).length === 1);
    const plannerSame = await start(s.keys.planner, { external_id: 'sess-1', title: 'Plan the sprint' });
    check('external_id: unique per agent, so another agent gets its own run', plannerSame.status === 201 && plannerSame.body.data.id !== run1.id, plannerSame.body);
    const plannerRun = plannerSame.body.data.id as string;

    // --- Own-only writes --------------------------------------------------------------------------
    const person = await start(s.keys.morgan, { title: 'Me too' });
    check('own: a person cannot start a run', person.status === 403 && reason(person) === 'agents_only', person.body);
    const forOther = await start(s.keys.planner, { agent_id: s.builder.id, title: 'For you' });
    check("own: an agent cannot start another agent's run", forOther.status === 403 && reason(forOther) === 'own_runs_only', forOther.body);
    const managed = await start(s.keys.owner, { agent_id: s.builder.id, title: 'Started by the supervisor' });
    check("own: agents.manage starts an agent's run for it", managed.status === 201 && managed.body.data.agent_id === s.builder.id, managed.body);
    const managedForPerson = await start(s.keys.owner, { agent_id: s.morgan.id });
    check('own: agents.manage only starts runs for agents', managedForPerson.status === 422 && reason(managedForPerson) === 'agent_id_not_agent', managedForPerson.body);
    const otherPatch = await patch(s.keys.planner, run1.id, { note: 'Not mine' });
    check("own: another agent's run is 404 to update", otherPatch.status === 404, otherPatch.body);
    const otherGet = await get(s.keys.planner, run1.id);
    check("own: another agent's run is 404 to read", otherGet.status === 404, otherGet.body);
    const otherList = await list(s.keys.planner, `?agent_id=${s.builder.id}`);
    check("own: listing another agent's runs is 403", otherList.status === 403 && reason(otherList) === 'own_runs_only', otherList.body);
    const ownList = await list(s.keys.planner, '?source=run');
    check('own: an agent lists its own runs only', ownList.status === 200 && ownList.body.data.length === 1 && ownList.body.data[0].id === plannerRun, ownList.body);
    const managerPatch = await patch(s.keys.owner, run1.id, { note: 'Supervisor: check the VAT rule too' });
    check("own: agents.manage updates any agent's run", managerPatch.status === 200, managerPatch.body);

    // --- Update ---------------------------------------------------------------------------------
    await patch(s.keys.builder, run1.id, { note: 'Reproduced with a 3-line cart' });
    const updated = await patch(s.keys.builder, run1.id, {
      plan: [{ title: 'Reproduce', status: 'done' }, { title: 'Fix', status: 'running' }], tokens_in: 12000, tokens_out: 800, cost_usd: 0.42,
    });
    const u = updated.body.data;
    check('update: plan replaced, notes added in order, totals set', updated.status === 200 && u.plan[0].status === 'done' && u.notes.length === 2
      && u.notes[0].text === 'Supervisor: check the VAT rule too' && u.notes[1].text === 'Reproduced with a 3-line cart'
      && u.tokens_in === 12000 && u.tokens_out === 800 && u.cost_usd === 0.42 && u.status === 'running', u);
    const totalsAgain = await patch(s.keys.builder, run1.id, { tokens_in: 12000, tokens_out: 800, cost_usd: 0.42 });
    check('update: totals, not increments, so a retry changes nothing', totalsAgain.body.data.tokens_in === 12000 && totalsAgain.body.data.cost_usd === 0.42, totalsAgain.body);
    for (let i = 0; i < 52; i++) await s.q("UPDATE pm.agent_runs SET notes = notes || jsonb_build_array(jsonb_build_object('at', now(), 'text', 'n' || $2::text)) WHERE id = $1 AND jsonb_array_length(notes) < 50", [run1.id, i]);
    const capped = await patch(s.keys.builder, run1.id, { note: 'The newest note' });
    check('update: only the newest 50 notes are kept', capped.status === 200 && capped.body.data.notes.length === 50 && capped.body.data.notes[49].text === 'The newest note', capped.body.data?.notes?.length);
    const empty = await patch(s.keys.builder, run1.id, {});
    check('update: an empty change is refused', empty.status === 422, empty.status);
    const badUrl = await patch(s.keys.builder, run1.id, { external_url: 'javascript:alert(1)' });
    check('update: the trace link must be http(s)', badUrl.status === 422, badUrl.status);

    // --- Webhooks, started ------------------------------------------------------------------------
    const startedEvents = await runEvents(run1.id);
    check('webhooks: run.started once, for the agent, nothing for updates', startedEvents.length === 1 && startedEvents[0].event_type === 'run.started'
      && JSON.stringify(startedEvents[0].payload.data.member_ids) === JSON.stringify([s.builder.id])
      && startedEvents[0].payload.data.run.external_id === 'sess-1' && startedEvents[0].payload.data.task_id === checkout, startedEvents);

    // --- Finish ---------------------------------------------------------------------------------
    const done = await finish(s.keys.builder, run1.id, { summary: 'Rounded per line, as the EU rule says', tokens_in: 15000, tokens_out: 1100, cost_usd: 0.55 });
    check('finish: succeeded by default, with finished_at and the final totals', done.status === 200 && done.body.data.status === 'succeeded'
      && !!done.body.data.finished_at && done.body.data.summary === 'Rounded per line, as the EU rule says' && done.body.data.tokens_in === 15000
      && typeof done.body.data.duration_ms === 'number', done.body);
    const doneAgain = await finish(s.keys.builder, run1.id, {});
    check('finish: again with the same status answers the run', doneAgain.status === 200 && doneAgain.body.data.status === 'succeeded', doneAgain.body);
    const failLate = await finish(s.keys.builder, run1.id, { status: 'failed' });
    check('finish: another status on a finished run is 409 run_finished', failLate.status === 409 && reason(failLate) === 'run_finished', failLate.body);
    const reopen = await patch(s.keys.builder, run1.id, { status: 'running' });
    check('finish: a finished run cannot run again', reopen.status === 409 && reason(reopen) === 'run_finished', reopen.body);
    const late = await patch(s.keys.builder, run1.id, { external_url: 'https://smith.example.test/runs/sess-1/final' });
    check('finish: a finished run still takes late details', late.status === 200 && late.body.data.external_url.endsWith('/final') && late.body.data.status === 'succeeded', late.body);
    const finishedEvents = await runEvents(run1.id);
    check('webhooks: run.finished once, after run.started, nothing for repeats or late details', finishedEvents.length === 2
      && finishedEvents[1].event_type === 'run.finished' && finishedEvents[1].sequence > finishedEvents[0].sequence
      && finishedEvents[1].payload.data.run.status === 'succeeded' && Number(finishedEvents[1].payload.data.run.cost_usd) === 0.55, finishedEvents.map((e) => e.event_type));
    const deliveries = await s.q<Loose>(`SELECT d.endpoint_id FROM pm.webhook_deliveries d JOIN pm.webhook_events e ON e.id = d.webhook_event_id
      WHERE e.resource_type = 'run' AND e.resource_id = $1`, [run1.id]);
    check("webhooks: delivered to the agent's endpoint only", deliveries.length === 2 && deliveries.every((d) => d.endpoint_id === builderHook) && !deliveries.some((d) => d.endpoint_id === plannerHook), deliveries);
    const tooEarly = await start(s.keys.builder, { title: 'x' });
    const before = await finish(s.keys.builder, tooEarly.body.data.id, { status: 'failed', finished_at: '2020-01-01T00:00:00Z' });
    check('finish: finished_at cannot be before the start', before.status === 422 && reason(before) === 'before_start', before.body);

    // --- A finished status is locked in the database, not only in the route ----------------------
    const finishedAt = (await s.q<{ finished_at: Date }>('SELECT finished_at FROM pm.agent_runs WHERE id = $1', [run1.id]))[0].finished_at;
    await s.q("UPDATE pm.agent_runs SET status = 'cancelled', finished_at = now() + interval '1 hour', summary = 'Late summary' WHERE id = $1", [run1.id]);
    const locked = (await s.q<Loose>('SELECT status, finished_at, summary FROM pm.agent_runs WHERE id = $1', [run1.id]))[0];
    check('lock: a direct write of another status to a finished run changes neither status nor finish time, but keeps late details',
      locked.status === 'succeeded' && new Date(locked.finished_at).getTime() === new Date(finishedAt).getTime() && locked.summary === 'Late summary', locked);
    const secondStatus = await patch(s.keys.builder, run1.id, { status: 'cancelled' });
    check('lock: the API answers a second, different status with 409 run_finished', secondStatus.status === 409 && reason(secondStatus) === 'run_finished', secondStatus.body);
    const raced = await start(s.keys.builder, { title: 'Raced' });
    const [raceFinish, raceCancel] = await Promise.all([
      finish(s.keys.builder, raced.body.data.id, { status: 'succeeded' }),
      patch(s.keys.builder, raced.body.data.id, { status: 'cancelled' }),
    ]);
    const racedRow = (await s.q<{ status: string }>('SELECT status FROM pm.agent_runs WHERE id = $1', [raced.body.data.id]))[0];
    const racedEvents = (await runEvents(raced.body.data.id)).filter((e) => e.event_type === 'run.finished');
    const winners = [raceFinish, raceCancel].filter((a) => a.status === 200);
    check('lock: a finish and a cancel at once: one wins, the other is 409, and the row and the one run.finished agree',
      winners.length === 1 && [raceFinish, raceCancel].some((a) => a.status === 409 && reason(a) === 'run_finished')
      && winners[0].body.data.status === racedRow.status && racedEvents.length === 1 && racedEvents[0].payload.data.run.status === racedRow.status,
      { finish: [raceFinish.status, raceFinish.body.data?.status], cancel: [raceCancel.status, raceCancel.body.data?.status], row: racedRow, events: racedEvents.map((e) => e.payload.data.run.status) });

    // --- Metadata: the API's bound is the one that counts ----------------------------------------
    const wide: Record<string, number> = {};
    for (let i = 0; JSON.stringify(wide).length < 7950; i++) wide[`k${i}`] = 1;
    delete wide[`k${Object.keys(wide).length - 1}`];
    const wideRun = await start(s.keys.builder, { title: 'Many keys', metadata: wide });
    check('metadata: near 8000 compact characters with hundreds of short keys starts fine', wideRun.status === 201
      && Object.keys(wideRun.body.data?.metadata ?? {}).length === Object.keys(wide).length, { status: wideRun.status, body: wideRun.body?.error, keys: Object.keys(wide).length, compact: JSON.stringify(wide).length });
    const tooWide = await start(s.keys.builder, { title: 'Too many keys', metadata: { ...wide, extra_key_over_the_line: 'x'.repeat(100) } });
    check('metadata: over 8000 compact characters is a 422 from the API', tooWide.status === 422, tooWide.status);
    const runsLib = await import('../src/lib/api/agent-runs');
    const mapped = (runsLib as Loose).runWriteError?.({ code: '23514', message: 'new row for relation "agent_runs" violates check constraint "agent_runs_metadata_shape"' });
    check('metadata: a database check on a run write reads as a clean 422', mapped?.statusCode === 422 && mapped.code === 'VALIDATION_ERROR'
      && mapped.details?.reason === 'run_check_failed' && mapped.details?.constraint === 'agent_runs_metadata_shape', mapped);

    // --- Stale reads ----------------------------------------------------------------------------
    const quiet = await s.task('Watch the nightly build');
    const stale = (await s.q<{ id: string }>(`INSERT INTO pm.agent_runs (agent_id, task_id, title, started_at, updated_at)
      VALUES ($1, $2, 'Went quiet', now() - interval '5 hours', now() - interval '3 hours') RETURNING id`, [s.builder.id, quiet]))[0].id;
    const staleGet = await get(s.keys.builder, stale);
    check('stale: a run quiet for over two hours reads timed_out', staleGet.status === 200 && staleGet.body.data.status === 'timed_out' && staleGet.body.data.finished_at === null, staleGet.body);
    const stored = (await s.q<{ status: string }>('SELECT status FROM pm.agent_runs WHERE id = $1', [stale]))[0];
    check('stale: the stored row stays running (no job, no write on read)', stored.status === 'running', stored);
    const viewRow = (await s.q<{ status: string }>('SELECT status FROM pm.agent_run_feed WHERE id = $1', [stale]))[0];
    check('stale: the view reads it timed_out too', viewRow?.status === 'timed_out', viewRow);
    const timedOut = await list(s.keys.builder, '?status=timed_out');
    const running = await list(s.keys.builder, '?status=running');
    check('stale: status=timed_out lists it and status=running does not', timedOut.body.data.some((r: Loose) => r.id === stale)
      && !running.body.data.some((r: Loose) => r.id === stale), [timedOut.body.data.map((r: Loose) => r.id), running.body.data.map((r: Loose) => r.id)]);
    const staleTask = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${quiet}`, { id: quiet }, s.keys.builder);
    check('stale: the task reads its latest run as timed_out', staleTask.body.data?.latest_run?.id === stale && staleTask.body.data.latest_run.status === 'timed_out', staleTask.body.data?.latest_run);
    const revived = await patch(s.keys.builder, stale, { note: 'Back: the build took a while' });
    check('stale: any update brings it back to running', revived.status === 200 && revived.body.data.status === 'running', revived.body);
    await finish(s.keys.builder, stale, { status: 'cancelled' });

    // --- Waiting on a person --------------------------------------------------------------------
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const ask = (apiKey: string, body: unknown) => call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, apiKey, body);
    const askApproval = (apiKey: string, body: unknown) => call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, apiKey, body);
    const waits = (await start(s.keys.builder, { title: 'Needs a decision' })).body.data.id as string;
    const toWaiting = await patch(s.keys.builder, waits, { status: 'waiting', note: 'Asked finance about rounding' });
    check('waiting: an agent PATCHes its run to waiting, unfinished', toWaiting.status === 200 && toWaiting.body.data.status === 'waiting'
      && toWaiting.body.data.finished_at === null, toWaiting.body);
    const waitingList = await list(s.keys.builder, '?status=waiting');
    check('waiting: status=waiting lists it', waitingList.status === 200 && waitingList.body.data.some((r: Loose) => r.id === waits && r.status === 'waiting'), waitingList.body);
    const stillWaiting = await patch(s.keys.builder, waits, { status: 'waiting', note: 'Still waiting on finance' });
    check('waiting: a note sent with status waiting keeps it waiting', stillWaiting.body.data?.status === 'waiting', stillWaiting.body);
    const supervisorNote = await patch(s.keys.owner, waits, { note: 'Supervisor: chase them tomorrow' });
    check("waiting: someone else's note (agents.manage) leaves it waiting", supervisorNote.status === 200 && supervisorNote.body.data.status === 'waiting', supervisorNote.body);
    const backToWork = await patch(s.keys.builder, waits, { note: 'Finance answered on the call' });
    check('waiting: any other update from its agent brings it back to running', backToWork.status === 200 && backToWork.body.data.status === 'running', backToWork.body);
    const explicitBack = await patch(s.keys.builder, waits, { status: 'waiting' });
    const explicitRun = await patch(s.keys.builder, waits, { status: 'running' });
    check('waiting: status running brings it back too', explicitBack.body.data?.status === 'waiting' && explicitRun.body.data?.status === 'running', [explicitBack.body, explicitRun.body]);
    const waitEvents = (await runEvents(waits)).map((e) => e.event_type);
    check('webhooks: waiting and back send no run.finished', !waitEvents.includes('run.finished'), waitEvents);

    // A question names the run: the run waits on it; the answer brings it back.
    const asked = await ask(s.keys.builder, { question: 'Round per line or per invoice?', run_id: waits, choices: ['Per line', 'Per invoice'] });
    check('waiting: a question with run_id answers 201 carrying run_id', asked.status === 201 && asked.body.data.run_id === waits, asked.body);
    check('waiting: the run it names is waiting', (await get(s.keys.builder, waits)).body.data.status === 'waiting');
    const plainAsk = await ask(s.keys.builder, { question: 'Anything else?' });
    check('waiting: a question without run_id carries no run_id', plainAsk.status === 201 && !('run_id' in plainAsk.body.data), plainAsk.body);
    await s.q("UPDATE pm.questions SET status = 'answered', answer_choice = 'Per line', answered_by = $2, answered_at = now() WHERE id = $1", [asked.body.data.id, s.owner.id]);
    check('waiting: answered, the run is running again', (await get(s.keys.builder, waits)).body.data.status === 'running');

    // run_id must be the asker's own unfinished run.
    const othersRun = await ask(s.keys.builder, { question: 'Whose run?', run_id: plannerRun });
    check("waiting: a question naming another agent's run is 422 run_not_yours", othersRun.status === 422 && reason(othersRun) === 'run_not_yours', othersRun.body);
    const missingRun = await ask(s.keys.builder, { question: 'Which run?', run_id: randomUUID() });
    check('waiting: a run that does not exist reads the same (422 run_not_yours)', missingRun.status === 422 && reason(missingRun) === 'run_not_yours', missingRun.body);
    const finishedRun = await ask(s.keys.builder, { question: 'Too late?', run_id: run1.id });
    check('waiting: a question naming a finished run is 409 run_finished', finishedRun.status === 409 && reason(finishedRun) === 'run_finished', finishedRun.body);
    const approvalOthers = await askApproval(s.keys.builder, { action: { type: 'deploy', summary: 'Deploy it' }, asked_to: s.owner.id, run_id: plannerRun });
    check("waiting: an approval naming another agent's run is refused the same way", approvalOthers.status === 422 && reason(approvalOthers) === 'run_not_yours', approvalOthers.body);
    const approval = await askApproval(s.keys.builder, { action: { type: 'deploy', summary: 'Deploy the rounding fix' }, asked_to: s.owner.id, run_id: waits });
    check('waiting: an approval with run_id holds the run', approval.status === 201 && approval.body.data.run_id === waits
      && (await get(s.keys.builder, waits)).body.data.status === 'waiting', approval.body);
    const finishedFromWaiting = await finish(s.keys.builder, waits, { status: 'cancelled', summary: 'Deploy no longer needed' });
    check('waiting: a run finishes from waiting', finishedFromWaiting.status === 200 && finishedFromWaiting.body.data.status === 'cancelled'
      && !!finishedFromWaiting.body.data.finished_at, finishedFromWaiting.body);
    const reWait = await patch(s.keys.builder, waits, { status: 'waiting' });
    check('waiting: a finished run cannot wait (409 run_finished)', reWait.status === 409 && reason(reWait) === 'run_finished', reWait.body);

    // --- Task linkage ---------------------------------------------------------------------------
    const latest = await start(s.keys.builder, { task_id: checkout, title: 'Second pass', external_url: 'https://smith.example.test/runs/2' });
    const taskRead = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${checkout}`, { id: checkout }, s.keys.morgan);
    const lr = taskRead.body.data?.latest_run;
    check('task: GET /tasks/{id} shows its latest run, to anyone who reads the task', taskRead.status === 200 && lr?.id === latest.body.data.id
      && lr.status === 'running' && lr.agent_id === s.builder.id && lr.agent_name === 'Builder' && lr.title === 'Second pass' && !!lr.started_at
      && JSON.stringify(Object.keys(lr).sort()) === JSON.stringify(['agent_id', 'agent_name', 'finished_at', 'id', 'started_at', 'status', 'title']), lr);
    check('task: a tasks.read key without agents.manage never sees the trace link', !JSON.stringify(taskRead.body).includes('smith.example.test/runs/2'), lr);
    const brief = await call(briefRoute.GET, 'GET', `/api/v1/tasks/${checkout}/brief`, { id: checkout }, s.keys.builder);
    check('task: the brief shows the same latest run, and stays bounded', brief.status === 200 && brief.body.data?.latest_run?.id === latest.body.data.id
      && JSON.stringify(brief.body.data).length < 36_000, brief.body.data?.latest_run ?? brief.body);
    const lonely = await s.task('Nothing ran here');
    const noRun = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${lonely}`, { id: lonely }, s.keys.builder);
    check('task: a task nobody ran has latest_run null', noRun.status === 200 && noRun.body.data.latest_run === null, noRun.body.data?.latest_run);
    check('task: the brief carries no trace link either', !JSON.stringify(brief.body).includes('smith.example.test/runs/2'), brief.body.data?.latest_run);
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'agents'");
    const offTask = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${checkout}`, { id: checkout }, s.keys.morgan);
    const offBrief = await call(briefRoute.GET, 'GET', `/api/v1/tasks/${checkout}/brief`, { id: checkout }, s.keys.morgan);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'agents'");
    check('task: with the AI agents module off, latest_run is null on the task and the brief', offTask.status === 200 && offTask.body.data.latest_run === null
      && offBrief.status === 200 && offBrief.body.data.latest_run === null, [offTask.status, offTask.body.data?.latest_run, offBrief.status, offBrief.body.data?.latest_run]);

    // --- Turns ----------------------------------------------------------------------------------
    const turnBase = (id: string, extra: Record<string, unknown> = {}) => ({
      source_turn_id: id, origin: 'scheduled', duration_ms: 4000, started_at: '2026-11-24T10:00:00+00:00', finished_at: '2026-11-24T10:00:04+00:00',
      outcome: 'work', tokens_scope: 'turn', tokens: { input: 1000, output: 200, cache_read: 5000 }, ...extra,
    });
    const live = await start(s.keys.builder, { external_id: 'sess-live', title: 'A long build' });
    const liveBefore = (await s.q<{ updated_at: string }>('SELECT updated_at FROM pm.agent_runs WHERE id = $1', [live.body.data.id]))[0].updated_at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The builder's turns: two naming runs, one naming the planner's run, one naming none, one idle, one session-scoped.
    const turns = [
      turnBase('b-1', { run_id: run1.id }),
      turnBase('b-2', { run_external_id: 'sess-live', duration_ms: 6000 }),
      turnBase('b-3', { run_id: plannerRun }),
      turnBase('b-4', { origin: 'directed', outcome: 'work', model: 'claude-opus' }),
      turnBase('b-5', { outcome: 'idle', duration_ms: 1000, tokens: { input: 300, output: 10 } }),
      turnBase('b-6', { tokens_scope: 'session_usage', tokens: { input: 90000, output: 9000 } }),
    ];
    for (const payload of turns) {
      const posted = await postTurn(s.keys.builder, payload);
      if (posted.status !== 201) failures.push(`turn ${payload.source_turn_id} not stored: ${JSON.stringify(posted.body)}`);
    }
    const stored1 = await s.q<Loose>("SELECT metadata->>'source_turn_id' AS id, metadata->>'run_id' AS run_id FROM pm.agent_activities WHERE activity_type = 'turn.completed' AND agent_id = $1 ORDER BY 1", [s.builder.id]);
    const runOf = Object.fromEntries(stored1.map((r) => [r.id, r.run_id]));
    check('turns: run_id naming one of its runs is kept', runOf['b-1'] === run1.id, runOf);
    check('turns: run_external_id resolves to the run id', runOf['b-2'] === live.body.data.id, runOf);
    check("turns: a run_id naming another agent's run is dropped", runOf['b-3'] === null, runOf);
    check('turns: a turn naming no run has none', runOf['b-4'] === null && runOf['b-5'] === null, runOf);
    const liveAfter = (await s.q<{ updated_at: string }>('SELECT updated_at FROM pm.agent_runs WHERE id = $1', [live.body.data.id]))[0].updated_at;
    check('turns: a turn on a running run counts as an update', new Date(liveAfter).getTime() > new Date(liveBefore).getTime(), [liveBefore, liveAfter]);
    const resent = await postTurn(s.keys.builder, turnBase('b-1', { run_id: run1.id }));
    check('turns: a resend is still one turn', resent.status === 201
      && (await s.q("SELECT 1 FROM pm.agent_activities WHERE metadata->>'source_turn_id' = 'b-1'")).length === 1, resent.status);

    const feed = await list(s.keys.builder, '?limit=100');
    const turnRows = feed.body.data.filter((r: Loose) => r.source === 'turn');
    const turnIds = turnRows.map((r: Loose) => r.external_id).sort();
    check('turns: those naming none of its runs read as finished runs; attached and idle ones do not', JSON.stringify(turnIds) === JSON.stringify(['b-3', 'b-4', 'b-6']), turnIds);
    const directed = turnRows.find((r: Loose) => r.external_id === 'b-4');
    check('turns: a turn run reads succeeded, with its trigger, outcome, duration and own tokens, never a cost', directed?.status === 'succeeded'
      && directed.trigger === 'chat' && directed.outcome === 'work' && directed.duration_ms === 4000 && directed.tokens_in === 1000
      && directed.tokens_out === 200 && directed.cost_usd === null && directed.model === 'claude-opus' && directed.started_at.startsWith('2026-11-24T10:00:00'), directed);
    const sessionScoped = turnRows.find((r: Loose) => r.external_id === 'b-6');
    check('turns: session totals are not a turn\'s own tokens, so they read null', sessionScoped?.tokens_in === null && sessionScoped.tokens_out === null, sessionScoped);
    const withTurns = await get(s.keys.builder, run1.id);
    check("turns: the run lists its turns, with their own tokens, beside the run's own totals", withTurns.body.data.turns?.count === 1
      && withTurns.body.data.turns.duration_ms === 4000 && withTurns.body.data.turns.tokens_in === 1000 && withTurns.body.data.turns.tokens_out === 200
      && withTurns.body.data.tokens_in === 15000, withTurns.body.data);
    const turnGet = await get(s.keys.builder, directed.id);
    check('turns: a turn id reads as a finished run', turnGet.status === 200 && turnGet.body.data.source === 'turn' && turnGet.body.data.plan.length === 0, turnGet.body);
    const turnGetOther = await get(s.keys.planner, directed.id);
    check("turns: another agent's turn is 404", turnGetOther.status === 404, turnGetOther.status);
    const onlyTurns = await list(s.keys.builder, '?source=turn&limit=100');
    check('list: source=turn lists only turns', onlyTurns.body.data.length === 3 && onlyTurns.body.data.every((r: Loose) => r.source === 'turn'), onlyTurns.body.data.length);
    const byTask = await list(s.keys.builder, `?task_id=${checkout}&limit=100`);
    check('list: task_id lists that task\'s runs, newest first', byTask.body.data.length === 2 && byTask.body.data.every((r: Loose) => r.task_id === checkout)
      && byTask.body.data[0].id === latest.body.data.id, byTask.body.data.map((r: Loose) => r.title));
    const everyone = await list(s.keys.owner, '?limit=100');
    check("list: agents.manage lists every agent's runs", everyone.status === 200 && everyone.body.data.some((r: Loose) => r.agent_id === s.planner.id)
      && everyone.body.data.some((r: Loose) => r.agent_id === s.builder.id), everyone.body.meta);

    // --- Analytics keep their numbers -----------------------------------------------------------
    // The planner posts the same turns and usage without naming a run: the
    // builder's (named) and the planner's (not) must read the same in analytics.
    for (const payload of turns) {
      const { run_id: _r, run_external_id: _e, ...plain } = payload as Record<string, unknown>;
      void _r; void _e;
      await postTurn(s.keys.planner, { ...plain, source_turn_id: `p-${payload.source_turn_id}` });
    }
    for (const [apiKey, who] of [[s.keys.builder, 'b'], [s.keys.planner, 'p']] as const) {
      await call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, apiKey, {
        activity_type: 'usage.recorded',
        payload: { source_usage_id: `${who}-u1`, model: 'claude-opus', input_tokens: 15000, output_tokens: 1100, cached_tokens: 4000, cost_usd: 0.55, recorded_at: new Date().toISOString() },
      });
    }
    await db.exec('RESET ROLE');
    const window = (await s.q<{ w: Loose }>("SELECT pm.agent_analytics_window(now() - interval '1 day', now() + interval '1 day', now() + interval '1 day') AS w"))[0].w;
    const turnTotals = (agentId: string) => {
      const rows = (window.turns as Loose[]).filter((t) => t[1] === agentId);
      return { turns: rows.length, ms: rows.reduce((n, t) => n + Number(t[5]), 0), tokens: rows.reduce((n, t) => n + Number(t[14] ?? 0), 0), outcomes: rows.map((t) => t[7]).sort().join(',') };
    };
    const usageTotals = (agentId: string) => {
      const rows = (window.usage_hours as Loose[]).filter((h) => h[0] === agentId);
      return { input: rows.reduce((n, h) => n + Number(h[3]), 0), output: rows.reduce((n, h) => n + Number(h[4]), 0), cost: rows.reduce((n, h) => n + Number(h[6]), 0) };
    };
    const bt = turnTotals(s.builder.id);
    const pt = turnTotals(s.planner.id);
    check('analytics: turns naming a run read exactly as the same turns naming none', JSON.stringify(bt) === JSON.stringify(pt) && bt.turns === 6, { bt, pt });
    check('analytics: usage tokens and cost are the same, and runs add nothing to them', JSON.stringify(usageTotals(s.builder.id)) === JSON.stringify(usageTotals(s.planner.id))
      && usageTotals(s.builder.id).cost === 0.55 && usageTotals(s.builder.id).input === 15000, [usageTotals(s.builder.id), usageTotals(s.planner.id)]);
    // Every turn's own tokens land in exactly one place: a turn row, a run's turns, or (no work) nowhere in runs.
    const raw = (await s.q<{ input: string }>(`SELECT coalesce(sum((metadata->'tokens'->>'input')::bigint), 0) AS input FROM pm.agent_activities
      WHERE activity_type = 'turn.completed' AND agent_id = $1 AND metadata->>'tokens_scope' = 'turn'`, [s.builder.id]))[0].input;
    const inRows = turnRows.reduce((n: number, r: Loose) => n + (r.tokens_in ?? 0), 0);
    const inRuns = feed.body.data.filter((r: Loose) => r.source === 'run').reduce((n: number, r: Loose) => n + (r.turns?.tokens_in ?? 0), 0);
    const idle = 300;
    check('analytics: turn rows + runs\' turns + turns that did no work = every turn\'s own tokens, none twice', inRows + inRuns + idle === Number(raw), { inRows, inRuns, idle, raw });

    // --- MCP ------------------------------------------------------------------------------------
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      const parsed = t.input.parse(args) as Record<string, unknown>;
      return outcomeResult(await t.run(parsed, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const mcpStart = await runTool(s.keys.planner, s.planner.id, 'start_run', { title: 'Over MCP', external_id: 'mcp-1', idempotency_key: randomUUID() });
    const mcpId = mcpStart?.data?.id;
    const mcpWait = await runTool(s.keys.planner, s.planner.id, 'update_run', { run_id: mcpId, status: 'waiting' });
    check('MCP: update_run sets waiting', mcpWait?.ok === true && mcpWait.data?.status === 'waiting', mcpWait);
    const mcpUpdate = await runTool(s.keys.planner, s.planner.id, 'update_run', { run_id: mcpId, note: 'Halfway', tokens_in: 10 });
    check('MCP: any update_run without waiting brings it back to running', mcpUpdate?.data?.status === 'running', mcpUpdate);
    const mcpFinish = await runTool(s.keys.planner, s.planner.id, 'finish_run', { run_id: mcpId, status: 'failed', summary: 'The API was down' });
    const mcpGet = await runTool(s.keys.planner, s.planner.id, 'get_run', { run_id: mcpId });
    const mcpList = await runTool(s.keys.planner, s.planner.id, 'list_runs', { source: 'run' });
    check('MCP: start_run, update_run, finish_run, get_run and list_runs', mcpStart?.ok === true && mcpUpdate?.ok === true && mcpFinish?.data?.status === 'failed'
      && mcpGet?.data?.notes?.[0]?.text === 'Halfway' && mcpList?.data?.some((r: Loose) => r.id === mcpId), [mcpStart, mcpUpdate, mcpFinish, mcpGet?.error, mcpList?.error]);
    const mcpOther = await runTool(s.keys.planner, s.planner.id, 'update_run', { run_id: run1.id, note: 'Not mine' });
    check("MCP: another agent's run is out of reach", mcpOther?.ok === false && mcpOther.status === 404, mcpOther);

    // --- Context pack ---------------------------------------------------------------------------
    const pack = (await call(myContextRoute.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.builder)).body?.data?.pack;
    const toolNames = (pack?.tools ?? []).map((t: Loose) => t.name);
    check('context: the pack lists the run tools', ['start_run', 'update_run', 'finish_run', 'list_runs', 'get_run'].every((n) => toolNames.includes(n)), toolNames);
    check('context: and the run convention, with the trace link', (pack?.conventions ?? []).some((line: string) => /start_run/.test(line) && /finish_run/.test(line) && /external_url/.test(line)), pack?.conventions);

    // --- Row security ---------------------------------------------------------------------------
    await actAs(db, s.planner.user);
    const plannerSees = await s.q<Loose>('SELECT DISTINCT agent_id FROM pm.agent_run_feed');
    const plannerTable = await s.q<Loose>('SELECT DISTINCT agent_id FROM pm.agent_runs');
    await actAs(db, s.owner.user);
    const ownerSees = await s.q<Loose>('SELECT DISTINCT agent_id FROM pm.agent_run_feed');
    await actAs(db, s.morgan.user);
    const morganSees = await s.q<Loose>('SELECT count(*)::int AS n FROM pm.agent_run_feed');
    const morganWrite = await db.query("INSERT INTO pm.agent_runs (agent_id) VALUES ($1)", [s.morgan.id]).then(() => 'wrote', (e: Error) => e.message);
    await actAs(db, null);
    await db.exec('RESET ROLE');
    check('rls: an agent reads its own runs and turns only', plannerSees.length === 1 && plannerSees[0].agent_id === s.planner.id
      && plannerTable.length === 1 && plannerTable[0].agent_id === s.planner.id, [plannerSees, plannerTable]);
    check('rls: agents.manage reads every agent\'s', ownerSees.length === 2, ownerSees);
    check('rls: a member with neither reads none, and members never write', morganSees[0].n === 0 && morganWrite !== 'wrote', [morganSees, morganWrite]);

    // --- Trash and delete -----------------------------------------------------------------------
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [checkout]);
    const trashedGet = await get(s.keys.builder, run1.id);
    const trashedList = await list(s.keys.builder, '?source=run&limit=100');
    check('trash: a run on a task in Trash is out of reach with it', trashedGet.status === 404 && !trashedList.body.data.some((r: Loose) => r.task_id === checkout), [trashedGet.status, trashedList.body.data.length]);
    await s.q('UPDATE pm.tasks SET deleted_at = NULL WHERE id = $1', [checkout]);
    const del = await db.query('DELETE FROM pm.agent_runs WHERE id = $1', [run1.id]).then(() => 'deleted', (e: Error) => e.message);
    check('delete: runs are never permanently deleted', del !== 'deleted', del);
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`agent runs: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
