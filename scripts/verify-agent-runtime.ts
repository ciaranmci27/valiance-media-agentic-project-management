/**
 * Agent runtime (20261127002000_agent_runtime.sql), through the real v1
 * routes (withApi, supabase-js, a fake PostgREST over PGlite) and MCP:
 * - Instances: instance_id on run start, heartbeats, usage and fleet
 *   reports; the agent's detail counts its live workers ("3 working now").
 * - Chat claims: a lease on a message or a whole conversation, held by an
 *   agent and one of its workers; nobody else replies or marks handled
 *   while it lasts; a lapsed lease is free; conversations and their summary.
 * - Resume notes on runs; question and approval events carry run_id.
 * - Host keys: agents.host, bound to agents by an Owner; the host feed of
 *   those agents' events; leases held in their names; nothing else.
 * - max_run_spend_cents stops or refuses a run past it.
 * - Blocked runs: structured, on Needs you for managers and the task's
 *   people until the run moves.
 * - Answers that do the thing (project.update), checked at ask and answer.
 * - Readiness: time_tracking_off on next_task and get_my_status.
 * - Specialists ask their orchestrator first unless ask_people_directly.
 * - The migration mirrors schema.sql word for word and upgrades cleanly.
 *
 *   npm run -s test:agent-runtime
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { computeNeedsYou } from '../src/lib/autonomy';
import type { Project, Task } from '../src/lib/types';

const MIGRATION = '20261127002000_agent_runtime.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = `\n-- ============================================================\n-- RUNTIME FOR WORKER POOLS (${MIGRATION})\n-- ============================================================\n`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const AGENT_SCOPES = ['tasks.read', 'tasks.manage_assigned', 'agent_activity.write', 'projects.read', 'notifications.manage_own', 'questions.ask', 'time.manage_own'];

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  // Its section runs to the next section's banner (later releases append theirs after it) or the end.
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  const agent = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'agent') RETURNING id")).rows[0].id;
  const run = (await old.query<{ id: string }>('INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, $2) RETURNING id', [agent, 'Before'])).rows[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  // What 2.0.50 writes still works after it.
  await old.query("UPDATE pm.agent_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [run]);
  const after = (await old.query<Loose>('SELECT status, instance_id, blocked_at FROM pm.agent_runs WHERE id = $1', [run])).rows[0];
  check('upgrade: a run from before reads with no instance and no block, and the previous code still finishes it', after.status === 'succeeded' && after.instance_id === null && after.blocked_at === null, after);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await fresh.query<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('chat_claim', 'event_feed_read_host', 'my_blocked_runs', 'chat_conversation_of', 'ensure_chat_conversation', 'chat_thread_key')`)).rows;
  check('grants: no new function for anon; members only my_blocked_runs', grants.length === 6 && grants.every((g) => !g.anon && g.auth === (g.name === 'my_blocked_runs')), grants);
  await old.close();
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) => {
    const user = randomUUID();
    await q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('display_name', $3::text))", [user, `${name.toLowerCase()}@example.com`, name]);
    const id = (await q<{ id: string }>('UPDATE pm.team_members SET role = $2 WHERE auth_user_id = $1 RETURNING id', [user, role]))[0].id;
    return { id, user };
  };
  const owner = await member('Olivia', 'owner');
  const alexa = await member('Alexa', 'agent');
  const builder = await member('Builder', 'agent');
  const scout = await member('Scout', 'agent');
  const morgan = await member('Morgan', 'member');
  const riley = await member('Riley', 'member');
  await q('UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [alexa.id, builder.id]);
  const project = async (name: string, tracking: boolean) => (await q<{ id: string }>('INSERT INTO pm.projects (name, time_tracking_enabled, hourly_tracking) VALUES ($1, $2, false) RETURNING id', [name, tracking]))[0].id;
  const apex = await project('Apex', false);
  const gamma = await project('Gamma', false);
  const beta = await project('Beta', true);
  for (const p of [apex, gamma, beta]) {
    for (const m of [alexa.id, builder.id, scout.id, morgan.id, riley.id]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [p, m]);
  }
  // Morgan may not manage projects, whatever the role defaults say.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.manage', 'app', 'deny'), ($1, 'projects.manage', 'api', 'deny') ON CONFLICT DO NOTHING", [morgan.id]);
  const keyRows = new Map<string, string>();
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]))[0].id;
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    keyRows.set(secret, id);
    return secret;
  };
  const keys = {
    builder: await key(builder.id, AGENT_SCOPES),
    scout: await key(scout.id, AGENT_SCOPES.filter((s) => s !== 'time.manage_own')),
    alexa: await key(alexa.id, AGENT_SCOPES),
    morgan: await key(morgan.id, ['tasks.read', 'projects.read', 'questions.ask']),
    owner: await key(owner.id, ['agents.manage', 'team.read', 'team.manage', 'api_keys.manage_all', 'tasks.read', 'projects.read', 'projects.manage', 'approvals.decide', 'questions.ask']),
    host: await key(owner.id, ['agents.host']),
    morganHost: await key(morgan.id, ['agents.host']),
  };
  const task = async (title: string, projectId: string, assignee: string) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, $2, 'todo') RETURNING id", [projectId, title]))[0].id;
    await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, assignee]);
    return id;
  };
  const connection = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials, kind) VALUES ('slack', 'T1', 'Acme', 'pm1:x', 'company') RETURNING id"))[0].id;
  const message = async (agent: string, fields: { conversation: string; external?: string; thread?: string | null; direct?: boolean; text?: string; status?: string }) =>
    (await q<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_message_id, thread_id, is_direct, agent_id, member_id, text, is_request)
      VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
    [connection, fields.status ?? 'pending', fields.conversation, fields.external ?? null, fields.thread ?? null, fields.direct ?? false, agent, morgan.id, fields.text ?? 'hello']))[0].id;
  return { q, owner, alexa, builder, scout, morgan, riley, apex, gamma, beta, keys, keyRows, task, connection, message };
}

async function main() {
  await migrationChecks();

  // Needs you, pure: a blocked run shows for its task, once, and only when the task is in the list.
  const project = { id: 'p1', name: 'Apex' } as Project;
  const t = (id: string): Task => ({ id, project_id: 'p1', title: id, description: '', status: 'in_progress', priority: 'medium', assignee_ids: ['me'], due_date: null, tags: [], comments: [], acceptance_criteria: [], blocked_by_ids: [], parent_task_id: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' } as unknown as Task);
  const items = computeNeedsYou({
    tasks: [t('build')], suggestions: [], projects: [project], teamMemberId: 'me', includeSuggestions: false, oversight: false,
    blockedRuns: [
      { run_id: 'r1', agent_id: 'a1', agent_name: 'Builder', task_id: 'build', blocked_reason: 'Need the API key for Stripe', blocked_at: '2026-11-27T10:00:00Z' },
      { run_id: 'r2', agent_id: 'a1', agent_name: 'Builder', task_id: 'build', blocked_reason: 'older', blocked_at: '2026-11-27T09:00:00Z' },
      { run_id: 'r3', agent_id: 'a1', agent_name: 'Builder', task_id: 'not-mine', blocked_reason: 'x', blocked_at: '2026-11-27T11:00:00Z' },
    ],
  });
  check('needs you: a blocked run shows on its task, once (the newest), with its reason and run', items.length === 1 && items[0].kind === 'blocked'
    && items[0].runId === 'r1' && items[0].question === 'Need the API key for Stripe', items);

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const runsRoute = await import('../src/app/api/v1/agents/runs/route');
    const runRoute = await import('../src/app/api/v1/agents/runs/[id]/route');
    const heartbeatRoute = await import('../src/app/api/v1/agents/heartbeat/route');
    const healthRoute = await import('../src/app/api/v1/agents/health/route');
    const agentRoute = await import('../src/app/api/v1/agents/[id]/route');
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const messageRoute = await import('../src/app/api/v1/chat/messages/[id]/route');
    const replyRoute = await import('../src/app/api/v1/chat/messages/[id]/reply/route');
    const handledRoute = await import('../src/app/api/v1/chat/messages/[id]/handled/route');
    const msgClaim = await import('../src/app/api/v1/chat/messages/[id]/claim/route');
    const msgExtend = await import('../src/app/api/v1/chat/messages/[id]/extend/route');
    const msgRelease = await import('../src/app/api/v1/chat/messages/[id]/release/route');
    const convRoute = await import('../src/app/api/v1/chat/conversations/[id]/route');
    const convClaim = await import('../src/app/api/v1/chat/conversations/[id]/claim/route');
    const convRelease = await import('../src/app/api/v1/chat/conversations/[id]/release/route');
    const eventsRoute = await import('../src/app/api/v1/events/route');
    const keyAgentsRoute = await import('../src/app/api/v1/api-keys/[id]/agents/route');
    const taskClaimRoute = await import('../src/app/api/v1/tasks/[id]/claim/route');
    const nextRoute = await import('../src/app/api/v1/tasks/next/route');
    const statusRoute = await import('../src/app/api/v1/agents/me/status/route');
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const questionRoute = await import('../src/app/api/v1/questions/[id]/route');
    const answerRoute = await import('../src/app/api/v1/questions/[id]/answer/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const accessRoute = await import('../src/app/api/v1/agents/[id]/access/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { agentLimitsPatchSchema } = await import('../src/lib/agent-limits');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const tool = PM_TOOLS.find((x) => x.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return outcomeResult(await tool.run(tool.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), tool.write).structuredContent as Loose;
    };
    const startRun = (apiKey: string, body: unknown) => call(runsRoute.POST, 'POST', '/api/v1/agents/runs', {}, apiKey, body);
    const patchRun = (apiKey: string, id: string, body: unknown) => call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${id}`, { id }, apiKey, body);
    const getRun = (apiKey: string, id: string) => call(runRoute.GET, 'GET', `/api/v1/agents/runs/${id}`, { id }, apiKey);
    const lease = (route: { POST: (r: NextRequest, c: never) => Promise<Response> }, kind: 'messages' | 'conversations', action: string, apiKey: string, id: string, body: unknown = {}) =>
      call(route.POST, 'POST', `/api/v1/chat/${kind}/${id}/${action}`, { id }, apiKey, body);

    // ── 1. Instances ─────────────────────────────────────────────────────
    const w1Run = await startRun(s.keys.builder, { title: 'Worker one', instance_id: 'w1' });
    check('instances: a run starts with instance_id', w1Run.status === 201 && w1Run.body.data.instance_id === 'w1', w1Run.body);
    const badInstance = await startRun(s.keys.builder, { instance_id: 'bad id!' });
    check('instances: an instance_id that is not a plain id is 422', badInstance.status === 422, badInstance.body);
    const beat2 = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.builder, { instance_id: 'w2', working: false });
    check('instances: a worker\'s beat answers the live workers (w1 by its run, w2 by its beat)', beat2.status === 200 && beat2.body.data.instance_id === 'w2'
      && beat2.body.data.live_instances?.count === 2 && beat2.body.data.live_instances.working === 1, beat2.body);
    const beat3 = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.builder, { instance_id: 'w3', working: true });
    const health = (await s.q<Loose>('SELECT turn_running FROM pm.agent_health WHERE member_id = $1', [s.builder.id]))[0];
    check('instances: the agent reads working while any worker is', beat3.body.data.working === true && health?.turn_running === true, { beat3: beat3.body, health });
    const beat2Again = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.builder, { instance_id: 'w2', working: false });
    check('instances: an idle worker\'s beat does not mark the agent idle while another works', beat2Again.body.data.working === true, beat2Again.body);
    const detail = await call(agentRoute.GET, 'GET', `/api/v1/agents/${s.builder.id}`, { id: s.builder.id }, s.keys.owner);
    check('instances: the agent detail says 3 live workers, 2 working now', detail.status === 200 && detail.body.data.live_instances?.count === 3
      && detail.body.data.live_instances.working === 2 && detail.body.data.live_instances.instances.map((i: Loose) => i.instance_id).join() === 'w1,w2,w3', detail.body.data?.live_instances);
    await s.q("UPDATE pm.agent_instances SET last_seen_at = now() - interval '1 hour' WHERE instance_id = 'w2'");
    const stale = await call(agentRoute.GET, 'GET', `/api/v1/agents/${s.builder.id}`, { id: s.builder.id }, s.keys.owner);
    check('instances: a worker whose beat went stale is no longer live', stale.body.data.live_instances?.count === 2, stale.body.data?.live_instances);
    const usage = await call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.builder, {
      activity_type: 'usage.recorded', payload: { source_usage_id: 'u-1', model: 'm', input_tokens: 1, output_tokens: 1, cost_usd: 0.01, instance_id: 'w1' },
    });
    const usageRow = (await s.q<Loose>("SELECT metadata FROM pm.agent_activities WHERE activity_type = 'usage.recorded' AND metadata->>'source_usage_id' = 'u-1'"))[0];
    check('instances: usage carries instance_id', usage.status === 201 && usageRow?.metadata?.instance_id === 'w1', { usage: usage.body, usageRow });
    const fleet = await call(healthRoute.POST, 'POST', '/api/v1/agents/health', {}, s.keys.owner, {
      reports: [
        { member_id: s.scout.id, container_running: true, turn_running: false, instance_id: 'h1' },
        { member_id: s.scout.id, container_running: true, turn_running: true, instance_id: 'h2', turn_started_at: new Date().toISOString() },
      ],
    });
    const scoutHealth = (await s.q<Loose>('SELECT turn_running FROM pm.agent_health WHERE member_id = $1', [s.scout.id]))[0];
    const scoutInstances = await s.q<Loose>('SELECT instance_id FROM pm.agent_instances WHERE agent_id = $1 ORDER BY instance_id', [s.scout.id]);
    check('instances: a fleet report of two workers of one agent is kept per worker, the agent working when any is', fleet.status === 200
      && scoutHealth?.turn_running === true && scoutInstances.map((r) => r.instance_id).join() === 'h1,h2', { fleet: fleet.body, scoutHealth, scoutInstances });

    // ── 3. Resume notes ──────────────────────────────────────────────────
    const runId = w1Run.body.data.id as string;
    const noted = await patchRun(s.keys.builder, runId, { resume_notes: 'Step 3 of 5: tests written, fixing the rounding next.' });
    const read = await getRun(s.keys.builder, runId);
    check('resume notes: PATCH saves them and get_run returns them', noted.status === 200 && read.body.data.resume_notes === 'Step 3 of 5: tests written, fixing the rounding next.', read.body);
    const tooLong = await patchRun(s.keys.builder, runId, { resume_notes: 'x'.repeat(8001) });
    check('resume notes: capped at 8000 characters (422)', tooLong.status === 422, tooLong.status);
    const viaMcp = await runTool(s.keys.builder, s.builder.id, 'update_run', { run_id: runId, resume_notes: 'From MCP' });
    check('resume notes: MCP update_run sets them', viaMcp?.data?.resume_notes === 'From MCP', viaMcp);

    // ── 7. Blocked runs ──────────────────────────────────────────────────
    const blockedTask = await s.task('Wire up Stripe', s.beta, s.builder.id);
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [blockedTask, s.morgan.id]);
    const bRun = (await startRun(s.keys.builder, { task_id: blockedTask, title: 'Stripe' })).body.data.id as string;
    const noReason = await patchRun(s.keys.builder, bRun, { status: 'blocked' });
    check('blocked: a block says why (422 without blocked_reason)', noReason.status === 422, noReason.body);
    const blocked = await patchRun(s.keys.builder, bRun, { status: 'blocked', blocked_reason: 'Need the live Stripe key' });
    check('blocked: the run waits, blocked, with its reason', blocked.status === 200 && blocked.body.data.status === 'waiting' && blocked.body.data.blocked === true
      && blocked.body.data.blocked_reason === 'Need the live Stripe key' && !!blocked.body.data.blocked_at, blocked.body);
    const blockedEvent = (await s.q<Loose>("SELECT data FROM pm.event_feed WHERE event_type = 'run.updated' AND subject_id = $1 ORDER BY seq DESC LIMIT 1", [bRun]))[0];
    check('blocked: run.updated says blocked', blockedEvent?.data?.run?.blocked === true, blockedEvent);
    await sleep(200);
    const notice = await s.q<Loose>('SELECT title FROM pm.team_member_notifications WHERE user_id = $1 AND title = $2', [s.owner.id, 'Builder is blocked']);
    check('blocked: its managers are told (the Owners, when it has no owners)', notice.length === 1, notice);
    const blockedFor = async (user: string) => {
      await actAs(db, user);
      const rows = await s.q<Loose>('SELECT run_id, blocked_reason FROM pm.my_blocked_runs()');
      await actAs(db, null);
      await db.exec('RESET ROLE');
      return rows;
    };
    const forOwner = await blockedFor(s.owner.user);
    const forMorgan = await blockedFor(s.morgan.user);
    const forRiley = await blockedFor(s.riley.user);
    check('blocked: Needs you lists it for its manager and the task\'s people, not for anyone else', forOwner.some((r) => r.run_id === bRun)
      && forMorgan.some((r) => r.run_id === bRun && r.blocked_reason === 'Need the live Stripe key') && !forRiley.some((r) => r.run_id === bRun), { forOwner, forMorgan, forRiley });
    const notesOnly = await patchRun(s.keys.builder, bRun, { resume_notes: 'Waiting for the key' });
    check('blocked: saving resume notes keeps it blocked', notesOnly.body.data.status === 'waiting' && notesOnly.body.data.blocked === true, notesOnly.body.data);
    const moved = await patchRun(s.keys.builder, bRun, { note: 'Got the key, carrying on' });
    const afterMove = await blockedFor(s.morgan.user);
    check('blocked: when it moves (back to running), the block clears and leaves Needs you', moved.body.data.status === 'running' && moved.body.data.blocked === false
      && !afterMove.some((r) => r.run_id === bRun), { run: moved.body.data, afterMove });

    // ── 6. Spend per run ─────────────────────────────────────────────────
    check('spend: limits take max_run_spend_cents', agentLimitsPatchSchema.safeParse({ max_run_spend_cents: 100 }).success && !agentLimitsPatchSchema.safeParse({ max_run_spend_cents: 0 }).success);
    await s.q('INSERT INTO pm.agent_limits (agent_id, max_run_spend_cents) VALUES ($1, 100)', [s.scout.id]);
    const overStart = await startRun(s.keys.scout, { title: 'Too dear', cost_usd: 2 });
    check('spend: a start reporting more than one run may spend is refused (402 run_spend_exceeded), nothing made', overStart.status === 402
      && reason(overStart) === 'run_spend_exceeded' && (await s.q('SELECT 1 FROM pm.agent_runs WHERE title = $1', ['Too dear'])).length === 0, overStart.body);
    const dear = (await startRun(s.keys.scout, { title: 'Dear' })).body.data.id as string;
    const within = await patchRun(s.keys.scout, dear, { cost_usd: 0.5 });
    check('spend: within the limit it is a plain update', within.status === 200 && within.body.data.status === 'running', within.body);
    const over = await patchRun(s.keys.scout, dear, { cost_usd: 1.5 });
    const stopped = (await s.q<Loose>('SELECT status, cost_usd, notes FROM pm.agent_runs WHERE id = $1', [dear]))[0];
    check('spend: a run reported past it is stopped (cancelled, with a note) and the caller told (402)', over.status === 402 && reason(over) === 'run_spend_exceeded'
      && over.body.error.details.stopped === true && stopped.status === 'cancelled' && Number(stopped.cost_usd) === 1.5
      && /Stopped: spent/.test(stopped.notes.at(-1).text), { over: over.body, stopped });

    // ── 2 and 5. Chat claims and conversations ───────────────────────────
    const top = await s.message(s.builder.id, { conversation: 'C1', external: 'm1', text: 'Can you check the invoice?' });
    const followUp = await s.message(s.builder.id, { conversation: 'C1', external: 'm2', thread: 'm1', text: 'And the VAT line' });
    const other = await s.message(s.builder.id, { conversation: 'C1', external: 'm3', text: 'A new question' });
    const links = await s.q<Loose>('SELECT id, chat_conversation_id FROM pm.chat_messages WHERE id = ANY($1)', [[top, followUp, other]]);
    const conv = links.find((r) => r.id === top).chat_conversation_id;
    check('conversations: a channel message starts one, its thread joins it, the next top-level message starts another', !!conv
      && links.find((r) => r.id === followUp).chat_conversation_id === conv && links.find((r) => r.id === other).chat_conversation_id !== conv, links);
    const shown = await call(messageRoute.GET, 'GET', `/api/v1/chat/messages/${top}`, { id: top }, s.keys.builder);
    check('chat: a message carries chat_conversation_id and claim', shown.body.data?.chat_conversation_id === conv && shown.body.data.claim === null, shown.body.data);

    const c1 = await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w1' });
    check('claims: a worker claims a message', c1.status === 200 && c1.body.data.claim?.instance_id === 'w1' && c1.body.data.renewed === false, c1.body);
    const c1again = await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w1', lease_minutes: 60 });
    check('claims: claiming again renews it', c1again.status === 200 && c1again.body.data.renewed === true, c1again.body);
    const c2 = await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w2' });
    check('claims: another worker of the same agent is refused, told who holds it', c2.status === 409 && reason(c2) === 'claimed_by_other'
      && c2.body.error.details.instance_id === 'w1', c2.body);
    const reply2 = await call(replyRoute.POST, 'POST', `/api/v1/chat/messages/${top}/reply`, { id: top }, s.keys.builder, { text: 'On it', instance_id: 'w2' });
    check('claims: another worker cannot reply while it is leased', reply2.status === 409 && reason(reply2) === 'claimed_by_other', reply2.body);
    const handledNoInstance = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${top}/handled`, { id: top }, s.keys.builder, {});
    check('claims: nor mark it handled (with no instance either)', handledNoInstance.status === 409 && reason(handledNoInstance) === 'claimed_by_other', handledNoInstance.body);
    const ext2 = await lease(msgExtend, 'messages', 'extend', s.keys.builder, top, { instance_id: 'w2' });
    const ext1 = await lease(msgExtend, 'messages', 'extend', s.keys.builder, top, { instance_id: 'w1' });
    check('claims: only the holder extends', ext2.status === 409 && reason(ext2) === 'claimed_by_other' && ext1.status === 200, { ext2: ext2.body, ext1: ext1.body });
    const rel2 = await lease(msgRelease, 'messages', 'release', s.keys.builder, top, { instance_id: 'w2' });
    const rel1 = await lease(msgRelease, 'messages', 'release', s.keys.builder, top, { instance_id: 'w1' });
    check('claims: only the holder releases', rel2.status === 409 && rel1.status === 200 && rel1.body.data.released === true && rel1.body.data.claim === null, { rel2: rel2.body, rel1: rel1.body });
    await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w1' });
    await s.q("UPDATE pm.chat_messages SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [top]);
    const lapsedExtend = await lease(msgExtend, 'messages', 'extend', s.keys.builder, top, { instance_id: 'w1' });
    check('claims: a lapsed lease cannot be extended (409 claim_expired)', lapsedExtend.status === 409 && reason(lapsedExtend) === 'claim_expired', lapsedExtend.body);
    const takeover = await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w2' });
    check('claims: a lapsed lease is free for another worker', takeover.status === 200 && takeover.body.data.claim.instance_id === 'w2', takeover.body);
    const scoutClaim = await lease(msgClaim, 'messages', 'claim', s.keys.scout, top, {});
    check('claims: a message routed to another agent reads as missing', scoutClaim.status === 404, scoutClaim.body);
    const handled2 = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${top}/handled`, { id: top }, s.keys.builder, { instance_id: 'w2' });
    check('claims: the holder marks it handled', handled2.status === 200 && handled2.body.data.status === 'handled', handled2.body);
    const done = await lease(msgClaim, 'messages', 'claim', s.keys.builder, top, { instance_id: 'w1' });
    check('claims: a handled message has nothing to claim (409 message_done)', done.status === 409 && reason(done) === 'message_done', done.body);

    const cc = await lease(convClaim, 'conversations', 'claim', s.keys.builder, conv, { instance_id: 'w1', summary: 'Morgan asks about invoice 1042; VAT line looks off.' });
    check('conversations: a worker claims the whole conversation, with a summary', cc.status === 200 && cc.body.data.claim?.instance_id === 'w1' && cc.body.data.summary?.startsWith('Morgan'), cc.body);
    const followHandled = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${followUp}/handled`, { id: followUp }, s.keys.builder, { instance_id: 'w3' });
    check('conversations: while held, another worker cannot mark a message in it handled', followHandled.status === 409 && reason(followHandled) === 'claimed_by_other', followHandled.body);
    const scoutConv = await lease(convClaim, 'conversations', 'claim', s.keys.scout, conv, {});
    check('conversations: an agent with nothing routed there cannot claim it (404)', scoutConv.status === 404, scoutConv.body);
    const convRead = await call(convRoute.GET, 'GET', `/api/v1/chat/conversations/${conv}`, { id: conv }, s.keys.builder);
    check('conversations: GET answers its messages, lease and running summary', convRead.status === 200 && convRead.body.data.messages.length === 2
      && convRead.body.data.messages[0].id === top && convRead.body.data.claim?.instance_id === 'w1' && convRead.body.data.summary?.startsWith('Morgan')
      && convRead.body.data.thread_id === 'm1', convRead.body.data);
    const convScout = await call(convRoute.GET, 'GET', `/api/v1/chat/conversations/${conv}`, { id: conv }, s.keys.scout);
    check('conversations: anyone else reads it as missing', convScout.status === 404, convScout.body);
    const mcpConv = await runTool(s.keys.builder, s.builder.id, 'get_chat_conversation', { conversation_id: conv });
    check('mcp: get_chat_conversation reads it', mcpConv?.data?.id === conv && mcpConv.data.messages?.length === 2, mcpConv);
    const convRel = await lease(convRelease, 'conversations', 'release', s.keys.builder, conv, { instance_id: 'w1', summary: 'Handed back: VAT fixed.' });
    check('conversations: releasing leaves a summary', convRel.status === 200 && convRel.body.data.released === true
      && (await s.q<Loose>('SELECT summary FROM pm.chat_conversations WHERE id = $1', [conv]))[0].summary === 'Handed back: VAT fixed.', convRel.body);
    const mcpClaim = await runTool(s.keys.builder, s.builder.id, 'claim_chat_message', { message_id: other, instance_id: 'w5' });
    check('mcp: claim_chat_message claims for a worker', mcpClaim?.data?.claim?.instance_id === 'w5', mcpClaim);
    const dm = await s.message(s.builder.id, { conversation: 'D7', external: 'd1', direct: true });
    const dm2 = await s.message(s.builder.id, { conversation: 'D7', external: 'd2', direct: true });
    const dmLinks = await s.q<Loose>('SELECT chat_conversation_id FROM pm.chat_messages WHERE id = ANY($1)', [[dm, dm2]]);
    check('conversations: a DM is one conversation', dmLinks.length === 2 && dmLinks[0].chat_conversation_id === dmLinks[1].chat_conversation_id, dmLinks);

    // ── 4. Host keys ─────────────────────────────────────────────────────
    const hostKeyId = s.keyRows.get(s.keys.host)!;
    const unbound = await call(eventsRoute.GET, 'GET', '/api/v1/events', {}, s.keys.host);
    check('host: a host key bound to no agent hears nothing (403 no_host_agents)', unbound.status === 403 && reason(unbound) === 'no_host_agents', unbound.body);
    const byMorgan = await call(keyAgentsRoute.PUT, 'PUT', `/api/v1/api-keys/${hostKeyId}/agents`, { id: hostKeyId }, s.keys.morgan, { agent_ids: [s.builder.id] });
    check('host: only an Owner binds a host key', byMorgan.status === 403, byMorgan.body);
    const notHost = await call(keyAgentsRoute.PUT, 'PUT', `/api/v1/api-keys/${s.keyRows.get(s.keys.owner)}/agents`, { id: s.keyRows.get(s.keys.owner)! }, s.keys.owner, { agent_ids: [s.builder.id] });
    check('host: only a key that carries agents.host serves agents (422 not_a_host_key)', notHost.status === 422 && reason(notHost) === 'not_a_host_key', notHost.body);
    const notAgent = await call(keyAgentsRoute.PUT, 'PUT', `/api/v1/api-keys/${hostKeyId}/agents`, { id: hostKeyId }, s.keys.owner, { agent_ids: [s.morgan.id] });
    check('host: only agents are served (422 not_an_agent)', notAgent.status === 422 && reason(notAgent) === 'not_an_agent', notAgent.body);
    const bound = await call(keyAgentsRoute.PUT, 'PUT', `/api/v1/api-keys/${hostKeyId}/agents`, { id: hostKeyId }, s.keys.owner, { agent_ids: [s.builder.id] });
    check('host: an Owner binds it to agents', bound.status === 200 && bound.body.data.agent_ids.join() === s.builder.id && bound.body.data.agents[0].name === 'Builder', bound.body);
    const mcpBound = await runTool(s.keys.owner, s.owner.id, 'get_host_key_agents', { key_id: hostKeyId });
    check('mcp: get_host_key_agents reads it', mcpBound?.data?.agent_ids?.[0] === s.builder.id, mcpBound);
    const notBound = await call(eventsRoute.GET, 'GET', `/api/v1/events?agents=${s.scout.id}`, {}, s.keys.host);
    check('host: asking for an agent it does not serve is 403 agent_not_bound', notBound.status === 403 && reason(notBound) === 'agent_not_bound', notBound.body);
    const start = await call(eventsRoute.GET, 'GET', '/api/v1/events', {}, s.keys.host);
    const cursor = start.body.meta?.next_cursor as string;
    const forBuilder = await s.message(s.builder.id, { conversation: 'C9', external: 'h1', text: 'for builder' });
    const forScout = await s.message(s.scout.id, { conversation: 'C9', external: 'h2', text: 'for scout' });
    const page = await call(eventsRoute.GET, 'GET', `/api/v1/events?since=${encodeURIComponent(cursor)}`, {}, s.keys.host);
    const ids = (page.body.data ?? []).map((e: Loose) => e.subject.id);
    check('host: the feed serves the bound agents\' events, ids and status only, never another agent\'s', page.status === 200 && ids.includes(forBuilder) && !ids.includes(forScout)
      && page.body.data.every((e: Loose) => e.agent_id === s.builder.id && e.data.message?.text === undefined), page.body);
    const hostWaitCursor = page.body.meta.next_cursor as string;
    const t0 = Date.now();
    const waiting = call(eventsRoute.GET, 'GET', `/api/v1/events?since=${encodeURIComponent(hostWaitCursor)}&wait=8`, {}, s.keys.host);
    await sleep(600);
    const wakeMessage = await s.message(s.builder.id, { conversation: 'C9', external: 'h3', text: 'wake' });
    const woken = await waiting;
    check('host: a host wait wakes when its agent gets something', woken.status === 200 && woken.body.data.some((e: Loose) => e.subject.id === wakeMessage) && Date.now() - t0 < 7000,
      { status: woken.status, ms: Date.now() - t0, data: woken.body.data });
    const readContent = await call(messageRoute.GET, 'GET', `/api/v1/chat/messages/${forBuilder}`, { id: forBuilder }, s.keys.host);
    const replyAsHost = await call(replyRoute.POST, 'POST', `/api/v1/chat/messages/${forBuilder}/reply`, { id: forBuilder }, s.keys.host, { text: 'hi' });
    const handledAsHost = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${forBuilder}/handled`, { id: forBuilder }, s.keys.host, {});
    const askAsHost = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.host, { question: 'x' });
    check('host: it never reads content, replies, marks handled or asks (403 host_key_only)', [readContent, replyAsHost, handledAsHost, askAsHost].every((a) => a.status === 403 && reason(a) === 'host_key_only'),
      [readContent.body, replyAsHost.body, handledAsHost.body, askAsHost.body]);
    const noAgent = await lease(msgClaim, 'messages', 'claim', s.keys.host, forBuilder, { instance_id: 'w9' });
    check('host: a host lease names its agent (400 agent_id_required)', noAgent.status === 400 && reason(noAgent) === 'agent_id_required', noAgent.body);
    const wrongAgent = await lease(msgClaim, 'messages', 'claim', s.keys.host, forScout, { agent_id: s.scout.id, instance_id: 'w9' });
    check('host: never for an agent it does not serve', wrongAgent.status === 403 && reason(wrongAgent) === 'agent_not_bound', wrongAgent.body);
    const hostLease = await lease(msgClaim, 'messages', 'claim', s.keys.host, forBuilder, { agent_id: s.builder.id, instance_id: 'w9' });
    check('host: it claims a message in the agent\'s name, for a worker', hostLease.status === 200 && hostLease.body.data.claim.agent_id === s.builder.id && hostLease.body.data.claim.instance_id === 'w9', hostLease.body);
    const otherWorker = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${forBuilder}/handled`, { id: forBuilder }, s.keys.builder, { instance_id: 'w1' });
    const holderWorker = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${forBuilder}/handled`, { id: forBuilder }, s.keys.builder, { instance_id: 'w9' });
    check('host: the worker it was handed to answers; another worker cannot', otherWorker.status === 409 && holderWorker.status === 200, { otherWorker: otherWorker.body, holderWorker: holderWorker.body });
    const hostTask = await s.task('Host task', s.beta, s.builder.id);
    const hostTaskClaim = await call(taskClaimRoute.POST, 'POST', `/api/v1/tasks/${hostTask}/claim`, { id: hostTask }, s.keys.host, { agent_id: s.builder.id });
    check('host: it claims a task in the agent\'s name', hostTaskClaim.status === 200 && hostTaskClaim.body.data.claim?.member_id === s.builder.id, hostTaskClaim.body);
    const hostTaskRelease = await call(taskClaimRoute.DELETE, 'DELETE', `/api/v1/tasks/${hostTask}/claim?agent_id=${s.builder.id}`, { id: hostTask }, s.keys.host);
    check('host: and releases it', hostTaskRelease.status === 200 && hostTaskRelease.body.data.released === true, hostTaskRelease.body);
    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [s.builder.id]);
    const pausedClaim = await call(taskClaimRoute.POST, 'POST', `/api/v1/tasks/${hostTask}/claim`, { id: hostTask }, s.keys.host, { agent_id: s.builder.id });
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [s.builder.id]);
    check('host: nothing is handed to a paused agent\'s workers (423)', pausedClaim.status === 423, pausedClaim.body);
    const morganHost = await call(eventsRoute.GET, 'GET', '/api/v1/events', {}, s.keys.morganHost);
    check('host: a host key must be an Owner\'s (403 host_key_not_owner)', morganHost.status === 403 && reason(morganHost) === 'host_key_not_owner', morganHost.body);

    // ── 9. Readiness ─────────────────────────────────────────────────────
    const gammaTask = await s.task('Timed work', s.gamma, s.scout.id);
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [gammaTask, s.builder.id]);
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = ANY($1)", [[blockedTask, hostTask]]);
    const next = await call(nextRoute.GET, 'GET', `/api/v1/tasks/next?project_id=${s.gamma}`, {}, s.keys.builder);
    check('readiness: next_task says up front that time tracking is off where the work needs a timer', next.status === 200 && next.body.data?.id === gammaTask
      && next.body.data.can_start_work === false && next.body.data.skip_reason === 'time_tracking_off' && next.body.data.blockers[0]?.project_id === s.gamma, next.body.data);
    const nextScout = await call(nextRoute.GET, 'GET', `/api/v1/tasks/next?project_id=${s.gamma}`, {}, s.keys.scout);
    check('readiness: an agent whose work needs no timer is not blocked by it', nextScout.body.data?.can_start_work === true && nextScout.body.data.skip_reason === null, nextScout.body.data);
    const statusGamma = await call(statusRoute.GET, 'GET', `/api/v1/agents/me/status?project_id=${s.gamma}`, {}, s.keys.builder);
    const statusAll = await call(statusRoute.GET, 'GET', '/api/v1/agents/me/status', {}, s.keys.builder);
    check('readiness: get_my_status on that project says can_start_work false (time_tracking_off); in general it lists the blocker', statusGamma.body.data.can_start_work === false
      && statusGamma.body.data.skip_reason === 'time_tracking_off' && statusAll.body.data.can_start_work === true
      && statusAll.body.data.blockers.some((b: Loose) => b.project_id === s.gamma), { gamma: statusGamma.body.data, all: statusAll.body.data });
    const mcpStatus = await runTool(s.keys.builder, s.builder.id, 'get_my_status', { task_id: gammaTask });
    check('mcp: get_my_status takes task_id', mcpStatus?.data?.skip_reason === 'time_tracking_off', mcpStatus);

    // ── 8. Answers that do the thing ─────────────────────────────────────
    const turnOn = { type: 'project.update', summary: 'Turn on time tracking for Gamma', details: { project_id: s.gamma, time_tracking_enabled: true } };
    const toMorgan = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.scout, { action: turnOn, asked_to: s.morgan.id, project_id: s.gamma });
    check('actions: asking someone who cannot do it is refused when asked (422 asked_cannot_perform)', toMorgan.status === 422 && reason(toMorgan) === 'asked_cannot_perform', toMorgan.body);
    const badDetails = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.scout, { action: { ...turnOn, details: { project_id: s.gamma, name: 'x' } }, asked_to: s.owner.id });
    check('actions: only the safe fields (422 invalid_action_details)', badDetails.status === 422 && reason(badDetails) === 'invalid_action_details', badDetails.body);
    const sRun = (await startRun(s.keys.scout, { title: 'Needs a timer' })).body.data.id as string;
    const approval = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.scout, { action: turnOn, asked_to: s.owner.id, run_id: sRun });
    check('actions: the approval lists the action and that the person asked may do it', approval.status === 201 && approval.body.data.proposed_actions?.[0]?.asked_may_perform === true
      && approval.body.data.proposed_actions[0].on_choice === 'approve' && approval.body.data.performed === null, approval.body);
    const approvalId = approval.body.data.id as string;
    const decided = await call(answerRoute.POST, 'POST', `/api/v1/questions/${approvalId}/answer`, { id: approvalId }, s.keys.owner, { choice: 'approve' });
    const gammaNow = (await s.q<Loose>('SELECT time_tracking_enabled FROM pm.projects WHERE id = $1', [s.gamma]))[0];
    check('actions: approving does the thing, as whoever approved', decided.status === 200 && decided.body.data.performed?.status === 'done'
      && decided.body.data.performed.by === s.owner.id && gammaNow.time_tracking_enabled === true, { decided: decided.body, gammaNow });
    const approvalEvent = (await s.q<Loose>("SELECT data FROM pm.event_feed WHERE event_type = 'question.answered' AND subject_id = $1", [approvalId]))[0];
    check('events: a decided approval\'s question.answered carries run_id', approvalEvent?.data?.question?.run_id === sRun, approvalEvent);
    await s.q('UPDATE pm.projects SET time_tracking_enabled = false WHERE id = $1', [s.gamma]);
    const team = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Leads', 'leads') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3)', [team, s.owner.id, s.morgan.id]);
    // A question whose answer acts goes only to whom Scout may ask: the Leads group manages it (security review finding 4).
    await s.q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [s.scout.id, team]);
    const groupAsk = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.scout, {
      question: 'Turn on time tracking for Gamma?', choices: ['Turn it on', 'Leave it off'], asked_to_group: team, action: { type: 'project.update', details: { project_id: s.gamma, time_tracking_enabled: true } },
    });
    check('actions: a question carries an action on its first choice; a group may do it when a person in it can', groupAsk.status === 201
      && groupAsk.body.data.proposed_actions?.[0]?.on_choice === 'Turn it on' && groupAsk.body.data.proposed_actions[0].asked_may_perform === true, groupAsk.body);
    const groupId = groupAsk.body.data.id as string;
    const morganTries = await call(answerRoute.POST, 'POST', `/api/v1/questions/${groupId}/answer`, { id: groupId }, s.keys.morgan, { choice: 'Turn it on' });
    const stillOpen = (await s.q<Loose>('SELECT status FROM pm.questions WHERE id = $1', [groupId]))[0];
    check('actions: someone who cannot do it cannot answer the choice that does it (403 cannot_perform_action), and nothing is recorded',
      morganTries.status === 403 && reason(morganTries) === 'cannot_perform_action' && stillOpen.status === 'open', morganTries.body);
    const morganOff = await call(answerRoute.POST, 'POST', `/api/v1/questions/${groupId}/answer`, { id: groupId }, s.keys.morgan, { choice: 'Leave it off' });
    const gammaOff = (await s.q<Loose>('SELECT time_tracking_enabled FROM pm.projects WHERE id = $1', [s.gamma]))[0];
    check('actions: another choice is a plain answer: nothing is done', morganOff.status === 200 && morganOff.body.data.performed === null && gammaOff.time_tracking_enabled === false, morganOff.body);
    const readBack = await call(questionRoute.GET, 'GET', `/api/v1/questions/${groupId}`, { id: groupId }, s.keys.scout);
    check('actions: get_question lists the proposed action', readBack.body.data?.proposed_actions?.length === 1, readBack.body.data);
    const notListed = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.scout, { question: 'x?', choices: ['a'], action: { type: 'project.delete', details: {} }, asked_to: s.owner.id });
    check('actions: only the whitelist (422 action_not_performable)', notListed.status === 422 && reason(notListed) === 'action_not_performable', notListed.body);

    // ── 10. Orchestrator first ───────────────────────────────────────────
    const routed = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.builder, { question: 'Which VAT rate for Ireland?', asked_to: s.morgan.id });
    check('orchestrator: a specialist\'s question to a person goes to its orchestrator first', routed.status === 201 && routed.body.data.asked_to === s.alexa.id
      && routed.body.data.requested_to === s.morgan.id, routed.body.data);
    const peer = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.builder, { question: 'Did you run the tests?', asked_to: s.scout.id });
    check('orchestrator: a question to another agent goes straight to it', peer.body.data?.asked_to === s.scout.id && peer.body.data.requested_to === undefined, peer.body.data);
    const routedApproval = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.builder, { action: { type: 'deploy', summary: 'Deploy' }, asked_to: s.owner.id });
    check('orchestrator: an approval goes to the person asked', routedApproval.body.data?.asked_to === s.owner.id, routedApproval.body.data);
    const setDirect = await call(accessRoute.PUT, 'PUT', `/api/v1/agents/${s.builder.id}/access`, { id: s.builder.id }, s.keys.owner, { ask_people_directly: true });
    check('orchestrator: "Ask a person directly" is a setting on its access', setDirect.status === 200 && setDirect.body.data.ask_people_directly === true, setDirect.body);
    const direct = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.builder, { question: 'Which VAT rate for France?', asked_to: s.morgan.id });
    check('orchestrator: with it on, the question goes to the person', direct.body.data?.asked_to === s.morgan.id && direct.body.data.requested_to === undefined, direct.body.data);

    // ── MCP catalog ──────────────────────────────────────────────────────
    const names = new Set(PM_TOOLS.map((tool) => tool.name));
    check('mcp: the runtime tools are there', ['claim_chat_message', 'extend_chat_message_claim', 'release_chat_message', 'claim_chat_conversation',
      'extend_chat_conversation_claim', 'release_chat_conversation', 'get_chat_conversation', 'get_host_key_agents', 'set_host_key_agents'].every((n) => names.has(n)));
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`agent runtime: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
