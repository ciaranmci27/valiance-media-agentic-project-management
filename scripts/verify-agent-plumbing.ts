/**
 * Agent plumbing (20261124000300_agent_plumbing.sql) through the real v1 API
 * (withApi, supabase-js, a fake PostgREST over PGlite), and over MCP:
 * - Heartbeats: the fleet publisher's body and key work as before (row,
 *   history, agents.manage); an agent reports its own row with its own key
 *   (up, working, turn start kept within a turn, interval remembered, note
 *   replaced, container kept); another member's id, a person and an interval
 *   out of range are refused; history records a row without a container;
 *   staleness is judged per agent from its promised interval.
 * - Idempotency-Key on POSTs: a retry replays the first answer without a
 *   second task; another body is 422; a request still running is 409, and
 *   one left running for 10 minutes is taken over; error answers are not
 *   kept, so a retry succeeds; keys are per API key and path; an expired key
 *   runs again and the cleanup removes expired rows; a bad header is 400;
 *   MCP create tools share the store; the table is service role only.
 * - The task brief: its shape (task, project, context, comments, files,
 *   blockers, open question, claim, rules), its bounds (long text cut,
 *   context truncated, under the MCP cap), parts a key cannot read listed in
 *   omitted, and the same access as reading the task (scope, Trash, missing).
 * - The migration on the schema before it matches schema.sql and runs twice.
 *
 *   npm run -s test:agent-plumbing
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { deriveStatus, emptyTrace, heartbeatStaleAfterSeconds, type AgentHealth } from '../src/lib/agent-status';

const MIGRATION = '20261124000300_agent_plumbing.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- AGENT PLUMBING (20261124000300_agent_plumbing.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

const WORK_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'files.read'];

async function seed(db: PGlite) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role = 'agent') =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder');
  const planner = await member('Planner');
  const cron = await member('Cron');
  const reader = await member('Reader');
  const morgan = await member('Morgan', 'member');
  const pat = await member('Pat', 'member');
  const publisher = await member('Publisher', 'admin');
  await q('UPDATE pm.team_members SET agent_escalate_to = $1, agent_close_policy = $2 WHERE id = $3', [morgan, 'review', builder]);
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name, description) VALUES ($1, $2) RETURNING id', [name, `${name} for Acme`]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [builder, planner, cron, reader, morgan]);
  const queue = await project('Queue', [pat]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    builder: await key(builder, WORK_SCOPES),
    builderSecond: await key(builder, WORK_SCOPES),
    planner: await key(planner, WORK_SCOPES),
    cron: await key(cron, ['agent_activity.write']),
    reader: await key(reader, ['tasks.read']),
    morgan: await key(morgan, WORK_SCOPES),
    pat: await key(pat, WORK_SCOPES),
    publisher: await key(publisher, ['agents.manage']),
  };
  const task = async (projectId: string, title: string, assignees: string[] = [], fields: Record<string, unknown> = {}) => {
    const columns = ['project_id', 'title', ...Object.keys(fields)];
    const values = [projectId, title, ...Object.values(fields)];
    const id = (await q<{ id: string }>(
      `INSERT INTO pm.tasks (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  return { q, owner, builder, planner, cron, reader, morgan, pat, publisher, apex, queue, keys, task };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Body = { data?: Loose; meta?: Loose; error?: { code?: string; message?: string; details?: Record<string, Loose> } };
type Answer = { status: number; body: Body; headers: Headers };

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the agent plumbing section is there, last', at > 0 && banner > 0 && !SCHEMA_SQL.slice(at).includes('\n-- AGENT ', 1));
  const before = SCHEMA_SQL.slice(0, banner);
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('ALTER TABLE pm.agent_health ALTER COLUMN')).replace(/\r\n/g, '\n').trim()));
  const old = await createFullSchemaDatabase({ schemaSql: before });
  await old.query("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent')");
  await old.query("INSERT INTO pm.agent_health (member_id, container, container_running) SELECT id, 'fleet', true FROM pm.team_members WHERE name = 'Fleet'");
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  const kept = (await old.query<Loose>('SELECT container, expected_interval_seconds, status_note FROM pm.agent_health')).rows[0];
  check('upgrade: an existing row keeps its container and promises the one-minute beat', kept?.container === 'fleet' && kept?.expected_interval_seconds === 60 && kept?.status_note === null, kept);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
  for (const [label, sql] of [['migration', MIGRATION_SQL], ['schema.sql', SCHEMA_SQL]] as const) {
    check(`cron: ${label} schedules pm-api-idempotency-cleanup hourly`,
      /cron\.schedule\('pm-api-idempotency-cleanup', '23 \* \* \* \*', \$job\$SELECT pm\.cleanup_api_idempotency_keys\(\);\$job\$\)/.test(sql));
  }
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const healthRoute = await import('../src/app/api/v1/agents/health/route');
    const heartbeatRoute = await import('../src/app/api/v1/agents/heartbeat/route');
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const commentsRoute = await import('../src/app/api/v1/tasks/[id]/comments/route');
    const briefRoute = await import('../src/app/api/v1/tasks/[id]/brief/route');
    const { idempotencyRequestHash } = await import('../src/lib/api/idempotency');
    const { withApi } = await import('../src/lib/api/middleware');
    const { created } = await import('../src/lib/api/response');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller, MAX_RESULT_CHARS } = await import('../src/lib/mcp/server');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const publish = (apiKey: string, body: unknown) => call(healthRoute.POST, 'POST', '/api/v1/agents/health', {}, apiKey, body);
    const beat = (apiKey: string, body?: unknown) => call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, apiKey, body);
    const health = async (memberId: string) => (await s.q<Loose>(
      'SELECT container, container_running, turn_running, turn_started_at, reported_at, expected_interval_seconds, status_note FROM pm.agent_health WHERE member_id = $1', [memberId]))[0];
    const history = async (memberId: string) => s.q<Loose>('SELECT container_running FROM pm.agent_health_history WHERE member_id = $1 ORDER BY changed_at', [memberId]);
    const tool = (name: string) => {
      const found = PM_TOOLS.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = tool(name);
      const parsed = t.input.parse(args) as Record<string, unknown>;
      return outcomeResult(await t.run(parsed, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };

    // --- Heartbeats: the fleet publisher, unchanged ---------------------------------------------
    const published = await publish(s.keys.publisher, {
      reports: [{ member_id: s.planner, container: 'planner', container_running: true, turn_running: false }],
    });
    const plannerRow = await health(s.planner);
    check('publisher: the body it sends today is accepted as before', published.status === 200 && published.body.data?.reported === 1 && !!published.body.data?.reported_at, published);
    check('publisher: the row holds what it reported, with the one-minute beat', plannerRow?.container === 'planner' && plannerRow.container_running === true
      && plannerRow.turn_running === false && plannerRow.expected_interval_seconds === 60 && plannerRow.status_note === null, plannerRow);
    await publish(s.keys.publisher, { reports: [{ member_id: s.planner, container: 'planner', container_running: false, turn_running: false }] });
    check('publisher: history records the container going down', JSON.stringify((await history(s.planner)).map((r) => r.container_running)) === '[true,false]', await history(s.planner));
    const noManage = await publish(s.keys.builder, { reports: [{ member_id: s.builder, container: 'builder', container_running: true, turn_running: true }] });
    check('publisher: still needs agents.manage', noManage.status === 403 && noManage.body.error?.details?.reason === 'missing_key_scope_and_member_permission', noManage);
    const ghost = await publish(s.keys.publisher, { reports: [{ member_id: s.morgan, container: 'x', container_running: true, turn_running: false }] });
    check('publisher: still refuses a member who is not an agent', ghost.status === 400, ghost.status);

    // --- Heartbeats: an agent reports itself ----------------------------------------------------
    const first = await beat(s.keys.builder, {});
    const builderRow = await health(s.builder);
    check('self: an empty beat says the agent is up and not working', first.status === 200 && first.body.data?.member_id === s.builder && first.body.data?.working === false
      && first.body.data?.expected_interval_seconds === 60 && first.body.data?.stale_after_seconds === 180, first);
    check('self: the row has no container, and is up', builderRow?.container === null && builderRow.container_running === true && builderRow.turn_running === false, builderRow);
    check('history: a row without a container is recorded like any other', JSON.stringify((await history(s.builder)).map((r) => r.container_running)) === '[true]', await history(s.builder));
    const noBody = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.builder);
    check('self: a beat with no body at all is fine', noBody.status === 200, noBody);

    const working = await beat(s.keys.builder, { working: true, status_note: 'Fixing the checkout total' });
    const startedAt = working.body.data?.turn_started_at;
    check('self: working starts a turn now, with the note', working.status === 200 && working.body.data?.working === true && !!startedAt
      && Math.abs(new Date(startedAt).getTime() - Date.now()) < 60_000 && working.body.data?.status_note === 'Fixing the checkout total', working);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stillWorking = await beat(s.keys.builder, { working: true, expected_interval_seconds: 3600 });
    check('self: the same turn keeps when it began, and the note is replaced (cleared)', stillWorking.body.data?.turn_started_at === startedAt
      && stillWorking.body.data?.status_note === null, stillWorking.body.data);
    check('self: a declared interval sets the staleness', stillWorking.body.data?.expected_interval_seconds === 3600 && stillWorking.body.data?.stale_after_seconds === 7260, stillWorking.body.data);
    const given = await beat(s.keys.builder, { working: true, turn_started_at: '2026-11-24T10:00:00.000Z' });
    check('self: an explicit turn_started_at is taken', Date.parse(given.body.data?.turn_started_at) === Date.parse('2026-11-24T10:00:00.000Z'), given.body.data);
    const done = await beat(s.keys.builder, { working: false });
    check('self: the interval is remembered when a beat leaves it out; done clears the turn', done.body.data?.expected_interval_seconds === 3600
      && done.body.data?.working === false && done.body.data?.turn_started_at === null, done.body.data);

    const turnStart = '2026-11-24T09:30:00.000Z';
    await publish(s.keys.publisher, { reports: [{ member_id: s.planner, container: 'planner', container_running: true, turn_running: true, turn_started_at: turnStart }] });
    const publishedRow = await health(s.planner);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const plannerBeat = await beat(s.keys.planner, { expected_interval_seconds: 3600, status_note: 'Planning the sprint' });
    const plannerAfter = await health(s.planner);
    check('self: on a publisher\'s row a beat keeps the container, interval and turn the publisher reported', plannerBeat.status === 200
      && plannerAfter?.container === 'planner' && plannerAfter.expected_interval_seconds === 60 && plannerAfter.turn_running === true
      && Date.parse(plannerAfter.turn_started_at) === Date.parse(turnStart) && plannerAfter.container_running === true, plannerAfter);
    const at = (value: unknown) => new Date(value as string).getTime();
    check('self: and writes only the note, never reported_at (the publisher\'s beat stays the proof of liveness)', plannerBeat.body.data?.publisher_reports === true
      && plannerAfter?.status_note === 'Planning the sprint' && at(plannerAfter.reported_at) === at(publishedRow.reported_at)
      && at(plannerBeat.body.data?.reported_at) === at(publishedRow.reported_at)
      && plannerBeat.body.data?.expected_interval_seconds === 60 && plannerBeat.body.data?.working === true, { beat: plannerBeat.body.data, row: plannerAfter });
    const plannerStop = await beat(s.keys.planner, { working: false });
    check('self: a beat cannot clear a turn the publisher sees running', plannerStop.status === 200 && (await health(s.planner))?.turn_running === true, await health(s.planner));
    check('self: an agent without a publisher is told so', first.body.data?.publisher_reports === false, first.body.data);
    await publish(s.keys.publisher, { reports: [{ member_id: s.planner, container: 'planner', container_running: true, turn_running: false }] });
    check('publisher: a batch that declares no interval leaves the agent\'s alone', (await health(s.builder))?.expected_interval_seconds === 3600);
    await publish(s.keys.publisher, { reports: [
      { member_id: s.planner, container: 'planner', container_running: true, turn_running: false, expected_interval_seconds: 120 },
      { member_id: s.builder, container: 'builder', container_running: true, turn_running: false },
    ] });
    check('publisher: a batch that declares one sets every row (60 where left out)', (await health(s.planner))?.expected_interval_seconds === 120
      && (await health(s.builder))?.expected_interval_seconds === 60, [await health(s.planner), await health(s.builder)]);

    const cronBeat = await beat(s.keys.cron, { expected_interval_seconds: 3600 });
    check('self: a key with only agent_activity.write may beat', cronBeat.status === 200 && cronBeat.body.data?.member_id === s.cron, cronBeat);
    const readerBeat = await beat(s.keys.reader, {});
    check('self: a key with only tasks.read may beat', readerBeat.status === 200, readerBeat);

    const plannerBefore = await health(s.planner);
    const other = await beat(s.keys.builder, { member_id: s.planner, working: true });
    check('self: another member\'s id is refused', other.status === 403 && other.body.error?.details?.reason === 'own_heartbeat_only', other);
    check('self: and their row is untouched', JSON.stringify(await health(s.planner)) === JSON.stringify(plannerBefore), [plannerBefore, await health(s.planner)]);
    const own = await beat(s.keys.builder, { member_id: s.builder });
    check('self: its own id is fine', own.status === 200, own.status);
    const person = await beat(s.keys.morgan, {});
    check('self: a person cannot report a heartbeat', person.status === 403 && person.body.error?.details?.reason === 'agents_only', person);
    const tooOften = await beat(s.keys.builder, { expected_interval_seconds: 10 });
    const tooRare = await beat(s.keys.builder, { expected_interval_seconds: 86_401 });
    const longNote = await beat(s.keys.builder, { status_note: 'x'.repeat(281) });
    check('self: an interval outside 30 to 86400 or a note over 280 is refused', [tooOften, tooRare, longNote].every((r) => r.status === 422), [tooOften.status, tooRare.status, longNote.status]);
    const badPublisherInterval = await publish(s.keys.publisher, { reports: [{ member_id: s.planner, container_running: true, turn_running: false, expected_interval_seconds: 5 }] });
    check('publisher: container is optional, an interval out of range is not', badPublisherInterval.status === 422, badPublisherInterval.status);
    const noContainer = await publish(s.keys.publisher, { reports: [{ member_id: s.cron, container_running: true, turn_running: false }] });
    check('publisher: a report without a container is accepted', noContainer.status === 200 && (await health(s.cron))?.container === null, noContainer);

    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'agents'");
    const off = await beat(s.keys.builder, {});
    check('self: with AI agents off the heartbeat answers MODULE_OFF', off.status === 403 && off.body.error?.code === 'MODULE_OFF', off);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'agents'");

    // Cron reports itself only (its publisher report named no container).
    const mcpBeat = await runTool(s.keys.cron, s.cron, 'heartbeat', { working: true, status_note: 'Reviewing the PR' });
    check('MCP: heartbeat reports the key\'s own row', mcpBeat?.ok === true && mcpBeat.data?.member_id === s.cron && mcpBeat.data?.working === true
      && mcpBeat.data?.publisher_reports === false && (await health(s.cron))?.status_note === 'Reviewing the PR', mcpBeat);

    // --- Per-agent staleness -------------------------------------------------------------------
    const now = Date.now();
    const healthAt = (agoMs: number, intervalSeconds?: number): AgentHealth => ({
      containerRunning: true, turnRunning: false, turnStartedAt: null, reportedAt: now - agoMs,
      ...(intervalSeconds ? { expectedIntervalMs: intervalSeconds * 1000 } : {}),
    });
    check('staleness: two missed beats plus a minute', heartbeatStaleAfterSeconds(60) === 180 && heartbeatStaleAfterSeconds(3600) === 7260 && heartbeatStaleAfterSeconds(undefined) === 180);
    check('staleness: a one-minute agent quiet for 2.5 minutes is not offline', deriveStatus(emptyTrace(), now, 'working', healthAt(150_000, 60)).mood === 'idle');
    check('staleness: a one-minute agent quiet for 4 minutes is offline', deriveStatus(emptyTrace(), now, 'working', healthAt(240_000, 60)).mood === 'offline');
    check('staleness: a row that never declared an interval keeps the three minutes', deriveStatus(emptyTrace(), now, 'working', healthAt(240_000)).mood === 'offline'
      && deriveStatus(emptyTrace(), now, 'working', healthAt(150_000)).mood === 'idle');
    check('staleness: an hourly agent 50 minutes after its last run is idle, not offline', deriveStatus(emptyTrace(), now, 'working', healthAt(50 * 60_000, 3600)).mood === 'idle');
    check('staleness: an hourly agent that missed two runs is offline', deriveStatus(emptyTrace(), now, 'working', healthAt(125 * 60_000, 3600)).mood === 'offline');

    // --- Idempotency-Key -----------------------------------------------------------------------
    const create = (apiKey: string, body: unknown, key?: string) =>
      call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, apiKey, body, key ? { 'idempotency-key': key } : {});
    const countTitled = async (title: string) => Number((await s.q<{ n: number }>('SELECT count(*)::int AS n FROM pm.tasks WHERE title = $1', [title]))[0].n);
    const keyRows = async (key: string) => s.q<Loose>('SELECT * FROM pm.api_idempotency_keys WHERE idempotency_key = $1', [key]);

    const k1 = randomUUID();
    const body1 = { project_id: s.apex, title: 'Retry-safe task' };
    const made = await create(s.keys.builder, body1, k1);
    const replay = await create(s.keys.builder, body1, k1);
    check('idempotency: the first POST runs', made.status === 201 && !!made.body.data?.id, made);
    check('idempotency: a retry gets the same answer, marked replayed', replay.status === 201 && JSON.stringify(replay.body) === JSON.stringify(made.body)
      && replay.headers.get('idempotency-replayed') === 'true' && made.headers.get('idempotency-replayed') === null, { made: made.body.data?.id, replay: replay.body.data?.id });
    check('idempotency: and no second task', await countTitled('Retry-safe task') === 1, await countTitled('Retry-safe task'));
    const stored = (await keyRows(k1))[0];
    check('idempotency: the stored key names the API key, path and status', stored?.state === 'completed' && stored.path === '/api/v1/tasks' && stored.response_status === 201
      && new Date(stored.expires_at).getTime() - Date.now() > 23 * 3_600_000, stored);

    const reused = await create(s.keys.builder, { project_id: s.apex, title: 'Something else' }, k1);
    check('idempotency: the same key with another body is 422 idempotency_key_reused', reused.status === 422 && reused.body.error?.code === 'IDEMPOTENCY_KEY_REUSED'
      && reused.body.error?.details?.reason === 'idempotency_key_reused' && await countTitled('Something else') === 0, reused);
    const otherKey = await create(s.keys.builderSecond, body1, k1);
    check('idempotency: another API key with the same value is its own request', otherKey.status === 201 && otherKey.body.data?.id !== made.body.data?.id, otherKey.status);
    const onComments = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${made.body.data?.id}/comments`, { id: made.body.data?.id }, s.keys.builder,
      { user_id: s.builder, text: 'Started' }, { 'idempotency-key': k1 });
    const commentAgain = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${made.body.data?.id}/comments`, { id: made.body.data?.id }, s.keys.builder,
      { user_id: s.builder, text: 'Started' }, { 'idempotency-key': k1 });
    const comments = await s.q('SELECT 1 FROM pm.task_comments WHERE task_id = $1', [made.body.data?.id]);
    check('idempotency: another path with the same value is its own request, deduplicated too', onComments.status === 201 && commentAgain.status === 201
      && commentAgain.headers.get('idempotency-replayed') === 'true' && comments.length === 1, { first: onComments.status, again: commentAgain.status, comments: comments.length });

    const k2 = randomUUID();
    const body2 = { project_id: s.apex, title: 'Slow task' };
    await s.q(`INSERT INTO pm.api_idempotency_keys (api_key_id, path, idempotency_key, request_hash)
      SELECT id, '/api/v1/tasks', $1, $2 FROM pm.api_keys WHERE key_hash = $3`, [k2, idempotencyRequestHash('', JSON.stringify(body2)), createHash('sha256').update(s.keys.builder).digest('hex')]);
    const inFlight = await create(s.keys.builder, body2, k2);
    check('idempotency: a retry while the first is still running is 409 idempotency_in_flight', inFlight.status === 409 && inFlight.body.error?.code === 'IDEMPOTENCY_IN_FLIGHT'
      && inFlight.body.error?.details?.reason === 'idempotency_in_flight' && await countTitled('Slow task') === 0, inFlight);
    await s.q("UPDATE pm.api_idempotency_keys SET started_at = now() - interval '11 minutes' WHERE idempotency_key = $1", [k2]);
    const takeover = await create(s.keys.builder, body2, k2);
    check('idempotency: a claim left running for 10 minutes is taken over', takeover.status === 201 && await countTitled('Slow task') === 1, takeover.status);

    const k3 = randomUUID();
    const racers = await Promise.all([1, 2, 3].map(() => create(s.keys.builder, { project_id: s.apex, title: 'Raced task' }, k3)));
    check('idempotency: three at once make one task', await countTitled('Raced task') === 1
      && racers.every((r) => r.status === 201 || r.status === 409) && racers.some((r) => r.status === 201 && r.headers.get('idempotency-replayed') === null), racers.map((r) => r.status));

    const k4 = randomUUID();
    const body4 = { project_id: s.queue, title: 'Queue task' };
    const refused = await create(s.keys.builder, body4, k4);
    check('idempotency: an error answer is not kept', refused.status === 403 && (await keyRows(k4)).length === 0, { status: refused.status, rows: await keyRows(k4) });
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.queue, s.builder]);
    const retried = await create(s.keys.builder, body4, k4);
    check('idempotency: so a retry with the same key and body runs and succeeds', retried.status === 201 && retried.headers.get('idempotency-replayed') === null
      && await countTitled('Queue task') === 1, retried.status);
    await s.q('DELETE FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [s.queue, s.builder]);

    const invalid = await create(s.keys.builder, { project_id: s.apex }, randomUUID());
    check('idempotency: a request refused before it runs (validation) claims nothing', invalid.status === 422 && (await s.q('SELECT 1 FROM pm.api_idempotency_keys WHERE state = $1', ['in_flight'])).length === 0, invalid.status);
    const tooLong = await create(s.keys.builder, body1, 'k'.repeat(256));
    const spaced = await create(s.keys.builder, body1, 'two words');
    check('idempotency: a key over 255 characters or with spaces is 400 invalid_idempotency_key', [tooLong, spaced].every((r) => r.status === 400
      && r.body.error?.details?.reason === 'invalid_idempotency_key'), [tooLong.status, spaced.status]);
    const read = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${made.body.data?.id}`, { id: made.body.data?.id }, s.keys.builder, undefined, { 'idempotency-key': 'read-1' });
    check('idempotency: GETs ignore the header', read.status === 200 && (await keyRows('read-1')).length === 0, read.status);

    const k5 = randomUUID();
    await create(s.keys.builder, { project_id: s.apex, title: 'Expiring task' }, k5);
    await s.q("UPDATE pm.api_idempotency_keys SET expires_at = now() - interval '1 minute' WHERE idempotency_key = $1", [k5]);
    const afterExpiry = await create(s.keys.builder, { project_id: s.apex, title: 'Expiring task' }, k5);
    check('idempotency: after 24 hours the same key runs again', afterExpiry.status === 201 && afterExpiry.headers.get('idempotency-replayed') === null && await countTitled('Expiring task') === 2, afterExpiry.status);
    await s.q("UPDATE pm.api_idempotency_keys SET expires_at = now() - interval '1 minute' WHERE idempotency_key = $1", [k5]);
    const liveBefore = Number((await s.q<{ n: number }>("SELECT count(*)::int AS n FROM pm.api_idempotency_keys WHERE expires_at > now()"))[0].n);
    const cleaned = (await s.q<{ n: number }>('SELECT pm.cleanup_api_idempotency_keys() AS n'))[0].n;
    const liveAfter = Number((await s.q<{ n: number }>("SELECT count(*)::int AS n FROM pm.api_idempotency_keys WHERE expires_at > now()"))[0].n);
    check('idempotency: the cleanup removes expired keys and keeps live ones', cleaned === 1 && (await keyRows(k5)).length === 0 && liveAfter === liveBefore && liveAfter > 0, { cleaned, liveBefore, liveAfter });

    const grants = (await s.q<Loose>(`SELECT has_table_privilege('anon', 'pm.api_idempotency_keys', 'SELECT') AS anon,
      has_table_privilege('authenticated', 'pm.api_idempotency_keys', 'SELECT') AS member,
      has_function_privilege('authenticated', 'pm.claim_api_idempotency_key(uuid, text, text, text)', 'EXECUTE') AS claim,
      has_function_privilege('anon', 'pm.cleanup_api_idempotency_keys()', 'EXECUTE') AS cleanup`))[0];
    check('idempotency: the store is service role only', !grants.anon && !grants.member && !grants.claim && !grants.cleanup, grants);

    const k6 = randomUUID();
    const mcpFirst = await runTool(s.keys.builder, s.builder, 'create_task', { project_id: s.apex, title: 'MCP retry task', idempotency_key: k6 });
    const mcpAgain = await runTool(s.keys.builder, s.builder, 'create_task', { project_id: s.apex, title: 'MCP retry task', idempotency_key: k6 });
    check('MCP: create_task with an idempotency_key twice makes one task', mcpFirst?.ok === true && mcpAgain?.ok === true && mcpAgain.data?.id === mcpFirst.data?.id
      && await countTitled('MCP retry task') === 1, { first: mcpFirst?.data?.id, again: mcpAgain?.data?.id });
    const restSameKey = await create(s.keys.builder, { project_id: s.apex, title: 'MCP retry task' }, k6);
    check('MCP: the key travels as the header, not in the body (REST with the same body replays it)', restSameKey.status === 201 && restSameKey.headers.get('idempotency-replayed') === 'true'
      && restSameKey.body.data?.id === mcpFirst.data?.id, restSameKey.status);
    const mcpMismatch = await runTool(s.keys.builder, s.builder, 'create_task', { project_id: s.apex, title: 'Another MCP task', idempotency_key: k6 });
    check('MCP: the same key with other arguments is a refusal the agent can read', mcpMismatch?.ok === false && mcpMismatch.status === 422 && mcpMismatch.error?.reason === 'idempotency_key_reused', mcpMismatch);
    const createTools = ['create_task', 'add_task_comment', 'ask_human', 'add_reminder', 'add_task_file', 'add_subtask', 'add_acceptance_criterion', 'create_task_suggestion', 'notify_owner', 'add_project_context', 'log_lead_interaction'];
    check('MCP: every create tool takes idempotency_key', createTools.every((name) => 'idempotency_key' in tool(name).input.shape), createTools.filter((name) => !('idempotency_key' in tool(name).input.shape)));

    // A schema-less route (as custom /api/x routes are) reads the request itself.
    let ranSchemaless = 0;
    const schemaless = (request: NextRequest) => withApi(async () => {
      ranSchemaless++;
      const got = await request.json();
      return created({ echo: got, run: ranSchemaless });
    }, { permission: 'tasks.read' })(request);
    const postSchemaless = async (key: string, body: unknown): Promise<Answer> => {
      const response = await schemaless(new NextRequest('http://localhost/api/x/reports/run', {
        method: 'POST',
        headers: { 'x-api-key': s.keys.builder, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const k7 = randomUUID();
    const plain1 = await postSchemaless(k7, { week: 47 });
    check('idempotency: a route with no schema still reads its own body with the header', plain1.status === 201 && plain1.body.data?.echo?.week === 47 && plain1.body.data?.run === 1, plain1);
    const plain2 = await postSchemaless(k7, { week: 47 });
    check('idempotency: and its retry replays without running it again', plain2.status === 201 && plain2.headers.get('idempotency-replayed') === 'true'
      && plain2.body.data?.run === 1 && ranSchemaless === 1, { status: plain2.status, run: plain2.body.data?.run, ran: ranSchemaless });
    const plain3 = await postSchemaless(k7, { week: 48 });
    check('idempotency: a schema-less route checks the body too', plain3.status === 422 && plain3.body.error?.details?.reason === 'idempotency_key_reused' && ranSchemaless === 1, plain3.status);

    // --- The task brief ------------------------------------------------------------------------
    const brief = (id: string, apiKey: string) => call(briefRoute.GET, 'GET', `/api/v1/tasks/${id}/brief`, { id }, apiKey);
    const blocker = await s.task(s.apex, 'Ship the price list', [s.builder]);
    const work = await s.task(s.apex, 'Fix the checkout total', [s.builder], { description: `Spec: ${'d'.repeat(9000)}` });
    await s.q('INSERT INTO pm.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [work, blocker]);
    await s.q("INSERT INTO pm.task_acceptance_criteria (task_id, criterion, sort_order) VALUES ($1, 'Totals match the cart', 0), ($1, 'Tax is rounded once', 1)", [work]);
    await s.task(s.apex, 'Write the rounding test', [s.builder], { parent_task_id: work });
    for (let i = 0; i < 15; i++) await s.q('INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, $3)', [work, s.morgan, `${i}: note`]);
    await s.q("INSERT INTO pm.task_files (task_id, kind, url, name, added_by) VALUES ($1, 'link', 'https://loom.example.com/v/1', 'Walkthrough', $2)", [work, s.morgan]);
    for (let i = 0; i < 60; i++) {
      await s.q("INSERT INTO pm.project_context (project_id, category, content) VALUES ($1, 'technical_decision', $2)", [s.apex, `Decision ${i}: ${'c'.repeat(5000)}`]);
    }
    await s.q("INSERT INTO pm.project_context (project_id, category, content, is_active) VALUES ($1, 'constraint', 'Archived rule', false)", [s.apex]);
    const question = (await s.q<{ id: string }>("INSERT INTO pm.questions (task_id, asked_by, asked_to, question) VALUES ($1, $2, $3, 'Round per line or per order?') RETURNING id", [work, s.builder, s.morgan]))[0].id;
    await s.q("UPDATE pm.tasks SET claimed_by = $1, claimed_at = now(), claim_expires_at = now() + interval '30 minutes' WHERE id = $2", [s.builder, work]);

    const got = await brief(work, s.keys.builder);
    const b = got.body.data ?? {};
    check('brief: answers 200 with every part', got.status === 200 && ['task', 'project', 'project_context', 'comments', 'files', 'blockers', 'open_question', 'claim', 'rules', 'omitted']
      .every((part) => part in b), Object.keys(b));
    check('brief: the task with criteria and subtasks, comments lifted out', b.task?.id === work && b.task?.acceptance_criteria?.length === 2 && b.task?.subtasks?.length === 1
      && !('comments' in (b.task ?? {})) && !('claim' in (b.task ?? {})), Object.keys(b.task ?? {}));
    check('brief: a long description is cut and flagged', b.task?.description_truncated === true && b.task?.description.length <= 8001, b.task?.description?.length);
    check('brief: the project', b.project?.id === s.apex && b.project?.name === 'Apex' && b.project?.description === 'Apex for Acme' && Array.isArray(b.project?.member_ids), b.project);
    check('brief: active context only, truncated with a flag and a note', b.project_context?.total === 60 && b.project_context?.truncated === true
      && b.project_context?.entries.length > 0 && b.project_context?.entries.length < 60 && b.project_context?.entries.every((e: Loose) => e.category === 'technical_decision')
      && b.project_context?.entries[0].content_truncated === true && /get_project_context/.test(b.project_context?.note), { total: b.project_context?.total, shown: b.project_context?.entries?.length });
    check('brief: the newest 10 comments of 15', b.comments?.recent?.length === 10 && b.comments?.total === 15 && b.comments?.recent?.[9]?.text === '14: note'
      && /list_task_comments/.test(b.comments?.note), b.comments?.note);
    check('brief: files and links', b.files?.length === 1 && b.files[0].kind === 'link' && b.files[0].url === 'https://loom.example.com/v/1', b.files);
    check('brief: blockers', b.blockers?.blocked_by?.[0]?.id === blocker && b.blockers?.dependencies_met === false, b.blockers);
    check('brief: the open question', b.open_question?.id === question && b.open_question?.asked_to_name === 'Morgan', b.open_question);
    check('brief: the claim', b.claim?.member_id === s.builder && b.claim?.member_name === 'Builder', b.claim);
    check('brief: the caller\'s rules', b.rules?.is_agent === true && b.rules?.self_assign === true && b.rules?.close_policy === 'review'
      && b.rules?.create_policy === 'live' && b.rules?.escalate_to?.id === s.morgan && b.rules?.escalate_to?.name === 'Morgan', b.rules);
    check('brief: nothing omitted for a key that reads it all', Array.isArray(b.omitted) && b.omitted.length === 0, b.omitted);
    check('brief: bounded well under the MCP read cap', JSON.stringify(got.body).length < MAX_RESULT_CHARS, JSON.stringify(got.body).length);

    const narrow = await brief(work, s.keys.reader);
    check('brief: parts the key cannot read are left out and named', narrow.status === 200 && narrow.body.data?.project === null && narrow.body.data?.project_context === null
      && narrow.body.data?.files === null && JSON.stringify(narrow.body.data?.omitted?.map((o: Loose) => o.needs).sort()) === JSON.stringify(['files.read', 'project_context.read', 'projects.read'])
      && narrow.body.data?.task?.id === work, narrow.body.data?.omitted);
    const ownerRules = await brief(work, s.keys.morgan);
    check('brief: a person gets the default rules and no escalation', ownerRules.status === 200 && ownerRules.body.data?.rules?.is_agent === false
      && ownerRules.body.data?.rules?.escalate_to === null, ownerRules.body.data?.rules);

    const outsider = await brief(work, s.keys.pat);
    check('brief: a member outside the project is refused like reading the task', outsider.status === 403 && outsider.body.error?.details?.reason === 'project_scope', outsider);
    const outsiderTask = await call(taskRoute.GET, 'GET', `/api/v1/tasks/${work}`, { id: work }, s.keys.pat);
    check('brief: the same answer GET /tasks/{id} gives', outsiderTask.status === outsider.status && outsiderTask.body.error?.details?.reason === outsider.body.error?.details?.reason);
    const missing = await brief(randomUUID(), s.keys.builder);
    check('brief: a task that does not exist is 404', missing.status === 404, missing.status);
    const binned = await s.task(s.apex, 'Old idea', [s.builder]);
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [binned]);
    const trashed = await brief(binned, s.keys.builder);
    check('brief: a task in Trash is 404', trashed.status === 404 && trashed.body.error?.details?.reason === 'not_found_or_in_trash', trashed);

    // Every part at its largest, and no context to drop first.
    const huge = (await s.q<{ id: string }>("INSERT INTO pm.projects (name, description) VALUES ('Huge', $1) RETURNING id", [`P${'"\\'.repeat(25_000)}`]))[0].id;
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [huge, s.builder]);
    const big = await s.task(huge, 'Everything at once', [s.builder], { description: `D${'"'.repeat(50_000)}`, tags: Array.from({ length: 50 }, (_, i) => `${i}${'"'.repeat(98)}`) });
    for (let i = 0; i < 50; i++) {
      await s.q('INSERT INTO pm.task_acceptance_criteria (task_id, criterion, sort_order) VALUES ($1, $2, $3)', [big, `${i} ${'c'.repeat(1999)}`, i]);
    }
    for (let i = 0; i < 60; i++) await s.task(huge, `${i} ${'s'.repeat(495)}`, [s.builder], { parent_task_id: big });
    for (let i = 0; i < 30; i++) await s.q('INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, $3)', [big, s.morgan, `${i}: ${'m'.repeat(19_000)}`]);
    for (let i = 0; i < 60; i++) {
      await s.q("INSERT INTO pm.task_files (task_id, kind, url, name, note, added_by) VALUES ($1, 'link', $2, $3, $4, $5)",
        [big, `https://example.com/${i}/${'u'.repeat(1900)}`, `${i} ${'n'.repeat(250)}`, 'w'.repeat(500), s.morgan]);
    }
    const bigBrief = await brief(big, s.keys.builder);
    const bb = bigBrief.body.data ?? {};
    const bigSize = JSON.stringify(bigBrief.body).length;
    check('brief: every part at its largest still serializes under the cap', bigBrief.status === 200 && bigSize <= 36_500 && bigSize < MAX_RESULT_CHARS, bigSize);
    check('brief: no context to cut, so it says what it cut instead, in order', bb.project_context?.entries?.length === 0
      && JSON.stringify(bb.cut_to_fit) === JSON.stringify(['comments', 'files', 'subtasks', 'acceptance_criteria', 'descriptions']), bb.cut_to_fit);
    check('brief: each cut part is flagged with where to read the rest', bb.comments?.truncated === true && /list_task_comments/.test(bb.comments?.note)
      && /list_task_files/.test(bb.files_note) && bb.task?.subtasks_truncated === true && bb.task?.acceptance_criteria_truncated === true
      && bb.task?.description_truncated === true,
    { comments: bb.comments?.note, files: bb.files_note, subtasks: bb.task?.subtasks_note, criteria: bb.task?.acceptance_criteria_note, description: bb.task?.description?.length });
    check('brief: criteria are capped at 30 before any cutting', (bb.task?.acceptance_criteria?.length ?? 99) <= 30 && /get_task/.test(bb.task?.acceptance_criteria_note), bb.task?.acceptance_criteria_note);
    check('brief: a brief that fits is not marked cut', !('cut_to_fit' in b), b.cut_to_fit);
    const mcpBig = await runTool(s.keys.builder, s.builder, 'get_task_brief', { task_id: big });
    check('MCP: get_task_brief never answers 413, even at the largest', mcpBig?.ok === true, mcpBig?.error);

    const mcpBrief = await runTool(s.keys.builder, s.builder, 'get_task_brief', { task_id: work });
    check('MCP: get_task_brief reads the brief under the cap', mcpBrief?.ok === true && mcpBrief.data?.task?.id === work && mcpBrief.data?.rules?.close_policy === 'review', mcpBrief?.error ?? Object.keys(mcpBrief?.data ?? {}));
    const { PM_GUIDE } = await import('../src/lib/mcp/guide');
    check('guide: tells agents to start a task with get_task_brief', /Start every task with get_task_brief/.test(PM_GUIDE) && /idempotency_key/.test(PM_GUIDE) && /heartbeat/.test(PM_GUIDE));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent plumbing: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`agent plumbing: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
