/**
 * The agent event pipeline (20261124001200_agent_event_pipeline.sql) through
 * the real v1 API (withApi, supabase-js, a fake PostgREST over PGlite), MCP,
 * the database functions and the analytics read model:
 * - Labels: accepted beside the payload on typed, legacy and open events and
 *   over MCP; refused when malformed or more than 20; edited after the fact
 *   by the event's own agent or agents.manage (another agent's event is
 *   404); listed by label; grouped and filtered in analytics, an event with
 *   two labels on both rows.
 * - Export: needs agent_events.export; pages every event and run with a
 *   resume cursor; rows inserted between pages arrive once, after the
 *   cursor; a row that commits late with a lower seq is not skipped; a row in
 *   an open transaction waits; an edit sends the row again; types and agents
 *   filter; a key without projects.read_all exports only its projects.
 * - Webhook agent_event.created: nothing written while no endpoint
 *   subscribes; once per matching endpoint, filtered by agent and type, with
 *   the export's row shape.
 * - Provider: usage.recorded and runs take provider; old payloads are stored
 *   exactly as before; window v2 keeps model and provider and never merges a
 *   priced hour with an unpriced one, so the model breakdown reads as the raw
 *   records do and "Usage not split by model yet" is gone; the first window
 *   answers as it always did.
 * - run_id: a stored run with no tokens takes its attached turns' tokens,
 *   and only runs still without any count as reporting none.
 * - Server aggregates: pm.agent_run_stats and pm.agent_question_stats give
 *   the client model's totals and splits on the same fixture, in two
 *   timezones and under a project filter.
 * - Question visibility: projects the caller can open and their own;
 *   questions on no project only for an Owner or agents.manage.
 * - Provider plans: an estimate by token share, labelled, never in cost;
 *   only an Owner writes them.
 * - The migration on the schema before it matches schema.sql and runs
 *   twice, numbers old rows in creation order without touching a run's
 *   updated_at, and the previous release's ingest and window callers work on
 *   both sides of it.
 *
 *   npm run -s test:agent-event-pipeline
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { effectiveRunStatus } from '../src/lib/agent-runs';
import {
  ESTIMATE_LABEL, NO_LABEL, SUBSCRIPTION_LABEL, SUM_KINDS, UNSPLIT_MODEL,
  breakdown, buildAgentAnalytics, costLabel, median, subscriptionEstimate,
  type AgentAnalyticsInput, type BreakdownLabels, type Dimension, type QuestionRow, type RunRow,
} from '../src/lib/agent-analytics-model';
import { activitiesFromWindow, questionStatsFromAnswer, runStatsFromAnswer, type AnalyticsWindowPayload } from '../src/lib/agent-analytics-window';
import type { AgentActivity } from '../src/lib/types';

const MIGRATION = '20261124001200_agent_event_pipeline.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- EVENT PIPELINE: LABELS, EXPORT AND ANALYTICS (20261124001200_agent_event_pipeline.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const AGENT_SCOPES = ['tasks.read', 'agent_activity.write', 'projects.read', 'project_context.read', 'files.read', 'audit.read'];
const range = { startKey: '2026-11-10', endKey: '2026-11-12' };
const NOW = Date.parse('2026-11-12T20:00:00.000Z');

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
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
  const dana = await member('Dana', 'member');
  const lead = await member('Lead', 'member');
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const zenith = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Zenith') RETURNING id"))[0].id;
  for (const m of [builder.id, planner.id, morgan.id, dana.id]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  for (const m of [builder.id, planner.id]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [zenith, m]);
  // Lead oversees agents (agents.manage in the app) but is on no project.
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.manage', 'app', 'allow')`, [lead.id]);
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
    owner: await key(owner.id, ['agents.manage', 'agent_activity.write', 'tasks.read', 'projects.read', 'projects.read_all', 'agent_events.export', 'audit.read']),
    morgan: await key(morgan.id, ['tasks.read', 'projects.read', 'audit.read']),
    dana: await key(dana.id, ['agent_events.export']),
  };
  return { q, owner, builder, planner, morgan, dana, lead, apex, zenith, keys };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the agent event pipeline section is there', at > 0 && banner > 0);
  check('schema.sql: the section mirrors the migration body',
    SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Labels')).trim()));

  // The database before: what 2.0.22 runs on, with rows of every kind.
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const oq = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  await old.exec('RESET ROLE');
  const agent = (await oq<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent') RETURNING id"))[0].id;
  for (const [n, at] of [[3, '2026-11-01T03:00:00Z'], [1, '2026-11-01T01:00:00Z'], [2, '2026-11-01T02:00:00Z']] as const) {
    await oq(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata, created_at) VALUES ($1, 'work.claimed', $2, $3, $4)`,
      [agent, `Claimed: ${n}`, { task_title: String(n) }, at]);
  }
  const usage = { source_usage_id: 'old-u1', model: 'claude-opus', input_tokens: 100, output_tokens: 10, cached_tokens: 0, cost_usd: 0.1, recorded_at: '2026-11-01T01:30:00Z' };
  await oq(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata, created_at) VALUES ($1, 'usage.recorded', 'Recorded 110 tokens for claude-opus', $2, '2026-11-01T01:31:00Z')`, [agent, usage]);
  // A run last updated three hours ago: it reads timed_out, and must stay so.
  const stale = (await oq<{ id: string; updated_at: string }>(`INSERT INTO pm.agent_runs (agent_id, title, started_at) VALUES ($1, 'Stale', now() - interval '4 hours') RETURNING id`, [agent]))[0].id;
  await old.exec('ALTER TABLE pm.agent_runs DISABLE TRIGGER set_agent_runs_updated_at');
  await oq(`UPDATE pm.agent_runs SET updated_at = now() - interval '3 hours' WHERE id = $1`, [stale]);
  await old.exec('ALTER TABLE pm.agent_runs ENABLE TRIGGER set_agent_runs_updated_at');
  const staleBefore = (await oq<{ u: string }>('SELECT updated_at::text AS u FROM pm.agent_runs WHERE id = $1', [stale]))[0].u;
  const endpoint = (await oq<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Runs', 'https://hooks.example.test/r', 'whsec_x', '{run.started}') RETURNING id`))[0].id;
  const oldWindow = (await oq<{ w: Loose }>("SELECT pm.agent_analytics_window('2026-10-31', '2026-11-02', '2026-11-02') AS w"))[0].w;

  // New code before the migration: the ingest takes events without labels and says labels wait.
  // The API's rate limit, out of the way for the requests below and put back after.
  const rateLimit = (await oq<{ def: string }>("SELECT pg_get_functiondef('pm.consume_api_rate_limit(uuid,integer,integer)'::regprocedure) AS def"))[0].def;
  await old.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  // Strict, as PostgREST: selecting a column the database lacks is 42703.
  const server = await startFakePostgrest(old, { strictColumns: true });
  proxyTarget = server.url;
  try {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await oq(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Key', 'pk_live', $1, $2, '{agent_activity.write}', 'scoped')`,
      [createHash('sha256').update(secret).digest('hex'), agent]);
    await oq(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agent_activity.write', 'api', 'allow')`, [agent]);
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const post = async (body: unknown) => {
      const response = await activitiesRoute.POST(new NextRequest('http://localhost/api/v1/agent-activities', {
        method: 'POST', headers: { 'x-api-key': secret, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({}) } as never);
      return { status: response.status, body: await response.json() } as Answer;
    };
    const plain = await post({ activity_type: 'work.done', payload: { task_title: 'Before the update' } });
    check('before the migration: new code still records an event without labels', plain.status === 201 && plain.body.data?.title === 'Finished: Before the update', plain.body);
    const labelled = await post({ activity_type: 'work.done', payload: { task_title: 'Labelled early' }, labels: ['deploy'] });
    check('before the migration: an event with labels is 503 migration_pending, not stored without them', labelled.status === 503
      && labelled.body.error?.details?.reason === 'migration_pending', labelled.body);
    const queries = await import('../src/lib/supabase/queries');
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const window = await queries.fetchAgentAnalyticsWindow(createPmClient(server.url, 'fake-service-key'), { startKey: '2026-11-01', endKey: '2026-11-01' });
    check('before the migration: the analytics window falls back to the first version', window.rows.some((r) => r.activity_type === 'usage.recorded' && r.metadata.source_usage_id?.startsWith('hour:')), window.rows.length);

    // Webhook endpoints before the migration: Settings > Developers and the API
    // read and write them as before, with no agent event filter (null).
    const ownerId = (await oq<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Owen', 'owen@example.com', 'owner') RETURNING id"))[0].id;
    const ownerSecret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await oq(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Key', 'pk_live', $1, $2, '{webhooks.manage}', 'scoped')`,
      [createHash('sha256').update(ownerSecret).digest('hex'), ownerId]);
    const endpointsRoute = await import('../src/app/api/v1/webhook-endpoints/route');
    const endpointRoute = await import('../src/app/api/v1/webhook-endpoints/[id]/route');
    const hooks = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': ownerSecret, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() } as Answer;
    };
    const listed = await hooks(endpointsRoute.GET, 'GET', '/api/v1/webhook-endpoints', {});
    check('before the migration: GET /webhook-endpoints answers, agent_event_types null', listed.status === 200 && listed.body.data.length === 1
      && listed.body.data[0].agent_event_types === null && !('secret' in listed.body.data[0]), listed.body);
    const createdHook = await hooks(endpointsRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, { name: 'Early', url: 'https://hooks.example.test/e', events: ['task.created'] });
    check('before the migration: POST /webhook-endpoints creates one', createdHook.status === 201 && createdHook.body.data?.endpoint?.agent_event_types === null
      && typeof createdHook.body.data.secret === 'string', createdHook.body);
    const patchedHook = createdHook.body.data?.endpoint?.id
      ? await hooks(endpointRoute.PATCH, 'PATCH', `/api/v1/webhook-endpoints/${createdHook.body.data.endpoint.id}`, { id: createdHook.body.data.endpoint.id }, { name: 'Early, renamed' })
      : { status: 0, body: null };
    check('before the migration: PATCH /webhook-endpoints changes one', patchedHook.status === 200 && patchedHook.body.data?.name === 'Early, renamed'
      && patchedHook.body.data.agent_event_types === null, patchedHook.body);
    const screen = createPmClient(server.url, 'fake-service-key');
    const screenList = await queries.fetchWebhookEndpoints(screen).then((rows) => rows, (error: Error) => error);
    const screenAdd = await queries.insertWebhookEndpoint(screen, { name: 'Screen', url: 'https://hooks.example.test/s', secret: 'whsec_s', events: ['run.started'], created_by: null })
      .then((row) => row, (error: Error) => error);
    const screenSave = !(screenAdd instanceof Error)
      ? await queries.updateWebhookEndpoint(screen, screenAdd.id, { is_active: false }).then((row) => row, (error: Error) => error)
      : screenAdd;
    check('before the migration: Settings > Developers lists, adds and saves endpoints', Array.isArray(screenList) && screenList.every((e) => e.agent_event_types === null)
      && !(screenAdd instanceof Error) && screenAdd.agent_event_types === null && !(screenSave instanceof Error) && screenSave.is_active === false,
    [screenList instanceof Error ? screenList.message : screenList.length, screenAdd instanceof Error ? screenAdd.message : 'ok', screenSave instanceof Error ? screenSave.message : 'ok']);
  } finally {
    await server.close();
  }
  await old.exec('RESET ROLE');
  await old.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer); ${rateLimit};
    REVOKE ALL ON FUNCTION pm.consume_api_rate_limit(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION pm.consume_api_rate_limit(uuid, integer, integer) TO service_role;`);

  await applyMigrationsFrom(old, MIGRATION);
  const numbered = await oq<{ title: string; seq: string; change_txid: string }>(`SELECT title, seq::text, change_txid::text FROM pm.agent_activities WHERE activity_type = 'work.claimed' ORDER BY seq`);
  check('upgrade: rows written before are numbered in creation order, with change_txid 0',
    numbered.map((r) => r.title).join(',') === 'Claimed: 1,Claimed: 2,Claimed: 3' && numbered.every((r) => r.change_txid === '0'), numbered);
  const runRow = (await oq<{ seq: string | null; u: string; status: string }>(
    'SELECT r.seq::text, r.updated_at::text AS u, f.status FROM pm.agent_runs r JOIN pm.agent_run_feed f ON f.id = r.id WHERE r.id = $1', [stale]))[0];
  check('upgrade: a run is numbered without moving its updated_at, so it still reads timed_out', runRow?.seq !== null && runRow.u === staleBefore && runRow.status === 'timed_out', runRow);
  check('upgrade: no row is left without a number', (await oq('SELECT 1 FROM pm.agent_activities WHERE seq IS NULL UNION ALL SELECT 1 FROM pm.agent_runs WHERE seq IS NULL')).length === 0);
  const kept = (await oq<{ events: string[]; agent_event_types: string[] | null }>('SELECT events, agent_event_types FROM pm.webhook_endpoints WHERE id = $1', [endpoint]))[0];
  check('upgrade: endpoints keep their events and get no agent event filter', JSON.stringify(kept?.events) === '["run.started"]' && kept.agent_event_types === null, kept);
  const sameWindow = (await oq<{ w: Loose }>("SELECT pm.agent_analytics_window('2026-10-31', '2026-11-02', '2026-11-02') AS w"))[0].w;
  // The same answer, in any order (it never promised one).
  const sorted = (w: Loose) => JSON.stringify(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, (v as Loose[]).map((x) => JSON.stringify(x)).sort()])));
  check('upgrade: the first analytics window answers exactly as before (the previous release calls it)', sorted(sameWindow) === sorted(oldWindow), [oldWindow, sameWindow]);
  check('upgrade: its usage hours keep 8 fields and its turns 15', (sameWindow.usage_hours as Loose[]).every((h) => h.length === 8));
  // What the previous release does still works: it inserts and updates without the new columns.
  await oq(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'usage.recorded', 'Recorded 5 tokens for m', $2)`,
    [agent, { ...usage, source_usage_id: 'old-u2', input_tokens: 5, output_tokens: 0 }]);
  await oq(`UPDATE pm.agent_activities SET metadata = metadata || '{"outcome":"work"}' WHERE activity_type = 'work.claimed' AND title = 'Claimed: 1'`);
  const after = await oq<{ labels: string[]; seq: string }>(`SELECT labels, seq::text FROM pm.agent_activities WHERE metadata->>'source_usage_id' = 'old-u2'`);
  check('upgrade: the previous release\'s insert is numbered and has no labels', after[0]?.labels?.length === 0 && Number(after[0].seq) > 0, after);
  const feedCols = (await oq<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'agent_run_feed' ORDER BY ordinal_position`)).map((c) => c.column_name);
  check('upgrade: the run feed keeps exactly its columns (a second run of its own migration still works)', feedCols.join(',') === 'id,source,agent_id,task_id,project_id,status,outcome,title,summary,model,trigger,started_at,finished_at,duration_ms,tokens_in,tokens_out,cost_usd,external_id,external_url,sort_at,updated_at', feedCols);
  await old.exec(readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261124000500_agent_runs.sql'), 'utf8'));
  check('upgrade: the runs migration runs again after this one', true);
  // A later migration may replace a function the runs migration made (run webhooks carry the chain): bring them back.
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
}

/** A run feed row as the Analytics reads map it (agent-analytics-reads.ts toRunRow). */
function runRowOf(row: Loose): RunRow {
  const count = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return {
    id: row.id,
    source: row.source === 'turn' ? 'turn' : 'run',
    agentId: row.agent_id,
    projectId: row.project_id ?? null,
    status: row.source === 'turn' ? 'succeeded' : effectiveRunStatus({ status: row.status, updated_at: iso(row.updated_at) }),
    outcome: row.outcome ?? null,
    title: row.title ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    durationMs: count(row.duration_ms),
    tokensIn: count(row.tokens_in),
    tokensOut: count(row.tokens_out),
    costUsd: count(row.cost_usd),
  };
}

const iso = (value: string | Date) => new Date(value).toISOString();
/** JSON with keys in order: jsonb hands keys back sorted. */
const canon = (value: Record<string, unknown>) => JSON.stringify(Object.keys(value).sort().map((k) => [k, value[k]]));
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Runs, turns, usage, events and questions over 2026-11-10..12 (and a day either side). */
async function analyticsFixture(s: Seed) {
  const run = async (agent: string, fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    return (await s.q<{ id: string }>(`INSERT INTO pm.agent_runs (agent_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [agent, ...cols.map((c) => fields[c])]))[0].id;
  };
  const activity = async (agent: string | null, type: string, metadata: Record<string, unknown>, created: string, extra: { project?: string | null; labels?: string[]; reference?: string } = {}) =>
    (await s.q<{ id: string }>(`INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata, created_at, labels, reference_type, reference_id)
      VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [agent, extra.project ?? null, type, metadata, created, extra.labels ?? [], extra.reference ? 'task' : null, extra.reference ?? null]))[0].id;
  const { builder, planner, apex, zenith } = s;

  // Planner: no usage ledger, so its runs carry its tokens.
  const attachedRun = await run(planner.id, { project_id: apex, status: 'succeeded', title: 'Attached', model: 'gpt-x', provider: 'openai', started_at: '2026-11-10T10:00:00Z', finished_at: '2026-11-10T11:00:00Z' });
  await run(planner.id, { project_id: apex, status: 'succeeded', title: 'Silent', model: 'gpt-x', provider: 'openai', started_at: '2026-11-10T10:30:00Z', finished_at: '2026-11-10T12:00:00Z' });
  await run(planner.id, { project_id: zenith, status: 'failed', title: 'Deploy', model: 'openai/gpt-y', started_at: '2026-11-11T09:00:00Z', finished_at: '2026-11-11T09:10:00Z', tokens_in: 1000, tokens_out: 50, cost_usd: 0.4 });
  await run(planner.id, { project_id: zenith, status: 'failed', title: 'Deploy', model: 'openai/gpt-y', started_at: '2026-11-11T09:30:00Z', finished_at: '2026-11-11T09:40:00Z', tokens_in: 800 });
  await run(planner.id, { project_id: zenith, status: 'cancelled', title: 'Stopped', started_at: '2026-11-12T23:30:00Z', finished_at: '2026-11-13T00:30:00Z', tokens_in: 10, tokens_out: 1, cost_usd: 0 });
  await run(planner.id, { project_id: apex, status: 'running', title: 'Live', model: 'gpt-x', provider: 'openai', started_at: '2026-11-12T18:00:00Z', tokens_in: 100 });
  await run(planner.id, { status: 'succeeded', title: 'Before', started_at: '2026-11-08T10:00:00Z', finished_at: '2026-11-08T11:00:00Z', tokens_in: 5 });
  // Builder: a usage ledger, stored runs and turns that are runs of their own.
  await run(builder.id, { project_id: apex, status: 'succeeded', title: 'Ship', model: 'claude-opus', provider: 'anthropic', started_at: '2026-11-11T14:00:00Z', finished_at: '2026-11-11T15:00:00Z', tokens_in: 9000, tokens_out: 900, cost_usd: 1.2 });
  await run(builder.id, { project_id: zenith, status: 'timed_out', title: 'Hang', started_at: '2026-11-11T14:30:00Z', finished_at: '2026-11-11T16:30:00Z' });
  const turn = (id: string, startedAt: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    source_turn_id: id, origin: 'scheduled', duration_ms: minutes * 60_000, started_at: startedAt,
    finished_at: iso(new Date(Date.parse(startedAt) + minutes * 60_000)), outcome: 'work', ...extra,
  });
  await activity(builder.id, 'turn.completed', turn('t1', '2026-11-10T07:00:00Z', 20, { model: 'claude-opus', tokens_scope: 'turn', tokens: { input: 400, output: 30 } }), '2026-11-10T07:21:00Z');
  await activity(builder.id, 'turn.completed', turn('t2', '2026-11-11T06:50:00Z', 30, { outcome: 'failed' }), '2026-11-11T07:21:00Z');
  await activity(builder.id, 'turn.completed', turn('t3', '2026-11-12T22:00:00Z', 15, { outcome: 'blocked' }), '2026-11-12T22:16:00Z');
  await activity(builder.id, 'turn.completed', turn('t4', '2026-11-11T05:00:00Z', 5, { outcome: 'idle' }), '2026-11-11T05:06:00Z');
  // Attached to the planner's run: its own tokens fill the run that reports none.
  await activity(planner.id, 'turn.completed', turn('p1', '2026-11-10T10:05:00Z', 10, { run_id: attachedRun, tokens_scope: 'turn', tokens: { input: 500, output: 40 } }), '2026-11-10T10:16:00Z', { project: apex });
  // Usage: priced and unpriced in one hour, two providers, labels.
  const usage = (id: string, at: string, model: string, input: number, output: number, cost: number, extra: Record<string, unknown> = {}) =>
    ({ source_usage_id: id, model, input_tokens: input, output_tokens: output, cached_tokens: 10, cost_usd: cost, recorded_at: at, ...extra });
  await activity(builder.id, 'usage.recorded', usage('u1', '2026-11-10T09:05:00Z', 'claude-opus', 1000, 100, 0.5, { provider: 'anthropic' }), '2026-11-10T09:06:00Z', { project: apex, labels: ['client:acme', 'deploy'] });
  await activity(builder.id, 'usage.recorded', usage('u2', '2026-11-10T09:15:00Z', 'claude-opus', 2000, 200, 0, { provider: 'anthropic' }), '2026-11-10T09:16:00Z', { project: apex, labels: ['client:acme'] });
  await activity(builder.id, 'usage.recorded', usage('u3', '2026-11-10T09:25:00Z', 'gpt-x', 300, 30, 0.1, { provider: 'openai' }), '2026-11-10T09:26:00Z', { project: zenith });
  await activity(builder.id, 'usage.recorded', usage('u4', '2026-11-11T23:50:00Z', 'claude-opus', 700, 70, 0, { provider: 'anthropic' }), '2026-11-11T23:51:00Z');
  // Delivery events, labelled.
  const pr = 'https://github.com/acme/shop/pull/7';
  await activity(builder.id, 'work.handoff', { task_title: 'Checkout', pr_url: pr }, '2026-11-11T15:01:00Z', { project: apex, labels: ['client:acme'] });
  await activity(builder.id, 'pr.merged', { pr_url: pr, additions: 10, deletions: 2 }, '2026-11-11T18:00:00Z', { project: apex, labels: ['deploy'] });
  await activity(planner.id, 'turn.failed', { source_turn_id: 'f1', failure: 'failed', job_name: 'Nightly', started_at: '2026-11-12T03:00:00Z', finished_at: '2026-11-12T03:01:00Z' }, '2026-11-12T03:02:00Z', { labels: ['nightly'] });

  // Questions: on projects, on nothing, answered and not.
  const question = async (askedBy: string, askedTo: string, project: string | null, created: string, answered: string | null, approval = false) =>
    s.q(`INSERT INTO pm.questions (asked_by, asked_to, project_id, question, kind, action, choices, allow_other, status, answer_choice, answer_text, answered_at, answered_by, created_at)
      VALUES ($1, $2, $3, 'Go ahead?', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [askedBy, askedTo, project, approval ? 'approval' : 'question', approval ? { type: 'deploy', summary: 'Ship it' } : null,
      approval ? '["approve","reject"]' : null, !approval, answered ? 'answered' : 'open', approval && answered ? 'approve' : null,
      !approval && answered ? 'Yes' : null, answered, answered ? askedTo : null, created]);
  await question(builder.id, s.morgan.id, apex, '2026-11-10T10:00:00.123456Z', '2026-11-10T10:30:00.987654Z');
  await question(builder.id, s.owner.id, zenith, '2026-11-11T10:00:00Z', '2026-11-11T12:00:00Z');
  await question(planner.id, s.owner.id, null, '2026-11-11T11:00:00Z', '2026-11-11T11:05:00Z');
  await question(planner.id, s.dana.id, null, '2026-11-12T08:00:00Z', null);
  await question(planner.id, s.owner.id, apex, '2026-11-12T23:59:00Z', '2026-11-13T00:10:00Z', true);
  return { attachedRun };
}

async function analyticsChecks(s: Seed, db: PGlite) {
  await analyticsFixture(s);
  await db.exec('RESET ROLE');
  const agents = [{ id: s.builder.id, name: 'Builder', role: null }, { id: s.planner.id, name: 'Planner', role: null }];
  const projects = [{ id: s.apex, hourly_tracking: false, hourly_rate: null }, { id: s.zenith, hourly_tracking: false, hourly_rate: null }] as AgentAnalyticsInput['projects'];
  const rawActivities = (await s.q<Loose>('SELECT * FROM pm.agent_activities')).map((a) => ({ ...a, created_at: iso(a.created_at) })) as AgentActivity[];
  // The run's provider comes from agent_runs (the feed's columns stay as they were).
  const feed = (await s.q<Loose>(`SELECT f.*, r.provider FROM pm.agent_run_feed f LEFT JOIN pm.agent_runs r ON f.source = 'run' AND r.id = f.id
    WHERE f.sort_at >= '2026-11-09T00:00:00Z' AND f.sort_at <= '2026-11-13T23:59:59.999Z'`)).map(runRowOf);
  const questionRows: QuestionRow[] = (await s.q<Loose>(`SELECT asked_by, project_id, kind, created_at, answered_at FROM pm.questions
    WHERE deleted_at IS NULL AND created_at >= '2026-11-09T00:00:00Z' AND created_at <= '2026-11-13T23:59:59.999Z'`)).map((q) => ({
    askedBy: q.asked_by, projectId: q.project_id, kind: q.kind === 'approval' ? 'approval' : 'question', createdAt: iso(q.created_at), answeredAt: q.answered_at ? iso(q.answered_at) : null,
  }));
  const windowV2 = async () => (await s.q<{ w: AnalyticsWindowPayload }>(
    "SELECT pm.agent_analytics_window_v2('2026-11-09T00:00:00Z', '2026-11-13T23:59:59.999Z', '2026-11-25T00:00:00Z') AS w"))[0].w;
  const windowV1 = async () => (await s.q<{ w: AnalyticsWindowPayload }>(
    "SELECT pm.agent_analytics_window('2026-11-09T00:00:00Z', '2026-11-13T23:59:59.999Z', '2026-11-25T00:00:00Z') AS w"))[0].w;
  const v2 = activitiesFromWindow(await windowV2());
  const base = (over: Partial<AgentAnalyticsInput>): AgentAnalyticsInput => ({
    range, timezone: 'UTC', now: NOW, agents, projects, runs: [], activities: [], questions: [], tasks: [], reopens: [], timeEntries: [],
    billingModuleOn: false, canReadRevenue: false, ...over,
  });
  const labels: BreakdownLabels = { agentName: (id) => id, projectName: (id) => id, roleOf: () => null };

  // --- Provider and the window ----------------------------------------------------------------
  const w1 = await windowV1();
  const w2 = await windowV2();
  const hour9 = (rows: Loose[]) => rows.filter((h) => h[0] === s.builder.id && iso(h[2]) === '2026-11-10T09:00:00.000Z');
  check('window v1: one row per agent, project and hour, as the previous release reads it', hour9(w1.usage_hours as Loose[]).length === 2
    && (w1.usage_hours as Loose[]).every((h) => h.length === 8), hour9(w1.usage_hours as Loose[]));
  const apexHour = hour9(w2.usage_hours as Loose[]).filter((h) => h[1] === s.apex);
  check('window v2: a priced and an unpriced record in one hour stay two rows, each with its model and provider', apexHour.length === 2
    && apexHour.some((h) => h[10] === true && Number(h[6]) === 0.5 && h[8] === 'claude-opus' && h[9] === 'anthropic')
    && apexHour.some((h) => h[10] === false && Number(h[6]) === 0 && Number(h[3]) === 2000), apexHour);
  const rawModel = buildAgentAnalytics(base({ activities: rawActivities, runs: feed }));
  const v2Model = buildAgentAnalytics(base({ activities: v2.rows, runs: feed }));
  const byModel = (facts: typeof rawModel.facts) => Object.fromEntries(breakdown(facts, 'model', labels).map((r) => [`${r.sublabel}/${r.label}`, r.group.sums]));
  const rawRows = byModel(rawModel.facts);
  const v2Rows = byModel(v2Model.facts);
  check('provider: window v2 splits usage by model and provider exactly as the raw records do', Object.keys(rawRows).sort().join('|') === Object.keys(v2Rows).sort().join('|')
    && Object.keys(rawRows).every((k) => SUM_KINDS.every((kind) => close(rawRows[k][kind], v2Rows[k][kind]))), { rawRows, v2Rows });
  check('provider: "Usage not split by model yet" is gone once the data has a model', !breakdown(v2Model.facts, 'model', labels).some((r) => r.label === UNSPLIT_MODEL));
  check('provider: priced and unpriced tokens stay apart (cost is partial, never merged)', costLabel(v2Model.totals.sums).kind === 'partial' && v2Model.totals.sums.mergedCostUsd === 0
    && v2Model.totals.sums.unpricedTokens === rawModel.totals.sums.unpricedTokens, [costLabel(v2Model.totals.sums), v2Model.totals.sums.unpricedTokens]);
  check('provider: a usage record\'s own provider names the row', Object.keys(v2Rows).includes('anthropic/claude-opus') && Object.keys(v2Rows).includes('openai/gpt-x'), Object.keys(v2Rows));
  check('provider: a run\'s own provider names its row, else the model\'s prefix', Object.keys(v2Rows).includes('openai/gpt-x') && Object.keys(v2Rows).includes('openai/openai/gpt-y'), Object.keys(v2Rows));
  const v1Model = buildAgentAnalytics(base({ activities: activitiesFromWindow(w1).rows, runs: feed }));
  const ledgerTokens = (m: typeof v2Model) => m.facts.filter((f) => f.agentId === s.builder.id && f.kind === 'tokensIn').reduce((n, f) => n + f.value, 0);
  check('provider: the first window still files under "Usage not split by model yet", with the same usage', breakdown(v1Model.facts, 'model', labels).some((r) => r.label === UNSPLIT_MODEL)
    && ledgerTokens(v1Model) === ledgerTokens(v2Model) && close(v1Model.totals.sums.costUsd, v2Model.totals.sums.costUsd), [ledgerTokens(v1Model), ledgerTokens(v2Model)]);

  // --- run_id attribution -----------------------------------------------------------------
  const plannerSums = (m: typeof v2Model) => m.facts.filter((f) => f.agentId === s.planner.id && f.dateKey === '2026-11-10');
  const attachedIn = plannerSums(v2Model).filter((f) => f.kind === 'tokensIn').reduce((n, f) => n + f.value, 0);
  check('run_id: a stored run with no tokens takes its attached turn\'s own tokens', attachedIn === 500, attachedIn);
  check('run_id: only the run with no attached tokens still counts as reporting none', v2Model.totals.sums.runsNoTokens === 1, v2Model.totals.sums.runsNoTokens);
  const turnTuple = (w2.turns as Loose[]).find((t) => t[3] === 'p1');
  check('window v2: a turn tuple carries its run_id and its own input and output', turnTuple?.[15] && turnTuple[16] === 500 && turnTuple[17] === 40, turnTuple);
  const noRunIds = buildAgentAnalytics(base({ activities: v2.rows, runs: feed.map(({ id: _id, ...rest }) => { void _id; return rest; }) }));
  check('run_id: without the run ids the fill cannot happen (the test can fail)', noRunIds.totals.sums.runsNoTokens === 2, noRunIds.totals.sums.runsNoTokens);

  // --- Server aggregates equal the client model -----------------------------------------------
  for (const tz of ['UTC', 'America/Phoenix']) {
    for (const projectIds of [[], [s.apex]]) {
      const answer = (await s.q<{ r: Loose }>(`SELECT pm.agent_run_stats($1, $2, $3, $4, $5) AS r`,
        [range.startKey, range.endKey, tz, projectIds.length ? projectIds : null, new Date(NOW).toISOString()]))[0].r;
      const selectedProjectIds = projectIds.length ? new Set(projectIds) : undefined;
      const client = buildAgentAnalytics(base({ timezone: tz, activities: v2.rows, runs: feed, questions: questionRows, selectedProjectIds }));
      const qAnswer = (await (async () => { await actAs(db, s.owner.user); const r = (await s.q<{ r: Loose }>('SELECT pm.agent_question_stats($1, $2, $3) AS r', [range.startKey, range.endKey, tz]))[0].r; await actAs(db, null); await db.exec('RESET ROLE'); return r; })());
      // The run sums against the client's rows: without spend, which counts
      // tokens and cost by the newer rule (checked against pm.agent_spend below
      // and in test:agent-spend).
      const stats = runStatsFromAnswer(answer);
      const server = buildAgentAnalytics(base({ timezone: tz, activities: v2.rows, runStats: { ...stats, spend: undefined }, questionStats: questionStatsFromAnswer(qAnswer), selectedProjectIds }));
      const where = `${tz}${projectIds.length ? ', one project' : ''}`;
      if (projectIds.length === 0) {
        const withSpend = buildAgentAnalytics(base({ timezone: tz, activities: v2.rows, runStats: stats, questionStats: questionStatsFromAnswer(qAnswer) }));
        const sql = (await s.q<Loose>(`SELECT coalesce(sum(spent_usd), 0)::float8 AS usd, coalesce(sum(tokens_in), 0)::float8 AS tin, coalesce(sum(tokens_out), 0)::float8 AS tout
          FROM pm.agent_spend(($1::date)::timestamp AT TIME ZONE $3, ($2::date + 1)::timestamp AT TIME ZONE $3)`, [range.startKey, range.endKey, tz]))[0];
        const t = withSpend.totals.sums;
        check(`aggregates (${where}): with spend, tokens and cost are pm.agent_spend's`, Array.isArray(stats.spend) && close(t.costUsd, sql.usd) && t.tokensIn === sql.tin && t.tokensOut === sql.tout
          && SUM_KINDS.filter((k) => !['tokensIn', 'tokensOut', 'tokensCached', 'costUsd', 'unpricedTokens'].includes(k)).every((k) => close(t[k], server.totals.sums[k])),
        { model: [t.costUsd, t.tokensIn, t.tokensOut], sql });
      }
      const differs = SUM_KINDS.filter((kind) => !close(client.totals.sums[kind], server.totals.sums[kind]));
      check(`aggregates (${where}): server totals equal the client model's`, differs.length === 0,
        differs.map((k) => [k, client.totals.sums[k], server.totals.sums[k]]));
      check(`aggregates (${where}): median answer time equal`, median(client.totals.samples.answerMs) === median(server.totals.samples.answerMs)
        && client.totals.samples.answerMs.length === server.totals.samples.answerMs.length, [client.totals.samples.answerMs, server.totals.samples.answerMs]);
      for (const dimension of ['agent', 'project', 'model'] as Dimension[]) {
        const a = Object.fromEntries(breakdown(client.facts, dimension, labels).map((r) => [r.key, r.group.sums]));
        const b = Object.fromEntries(breakdown(server.facts, dimension, labels).map((r) => [r.key, r.group.sums]));
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        const bad = keys.filter((k) => !a[k] || !b[k] || SUM_KINDS.some((kind) => !close(a[k][kind], b[k][kind])));
        check(`aggregates (${where}): every ${dimension} row equal`, bad.length === 0, bad.map((k) => [k, a[k], b[k]]));
      }
      const days = (m: typeof client) => JSON.stringify([...new Set(m.facts.filter((f) => f.kind === 'busyMs').map((f) => `${f.dateKey}:${f.agentId}`))].sort());
      check(`aggregates (${where}): busy time lands on the same days`, days(client) === days(server), [days(client), days(server)]);
      if (tz === 'UTC' && projectIds.length === 0) {
        check('aggregates: the fixture means something (runs, busy, incidents, questions, tokens)', client.totals.sums.run >= 8 && client.totals.sums.busyMs > 0
          && client.totals.sums.incident >= 2 && client.totals.sums.question + client.totals.sums.approval >= 4 && client.totals.sums.tokensIn > 0, client.totals.sums);
        const unionPlanner = server.facts.filter((f) => f.kind === 'busyMs' && f.agentId === s.planner.id && f.dateKey === '2026-11-10').reduce((n, f) => n + f.value, 0);
        check('aggregates: overlapping runs count once (10:00-11:00 and 10:30-12:00 make 2h)', unionPlanner === 2 * 3_600_000, unionPlanner);
        check('aggregates: the run stats carry no row cap (every run in the range is summed)', (answer.groups as Loose[]).length > 0 && !('truncated' in answer));
      }
    }
  }

  // --- Question visibility -------------------------------------------------------------------
  const questionsAs = async (user: string) => {
    await actAs(db, user);
    const r = (await s.q<{ r: Loose }>('SELECT pm.agent_question_stats($1, $2, $3) AS r', ['2026-11-09', '2026-11-14', 'UTC']))[0].r;
    await actAs(db, null);
    await db.exec('RESET ROLE');
    const stats = questionStatsFromAnswer(r);
    return { scope: stats.scope, count: stats.groups.reduce((n, g) => n + g.questions + g.approvals, 0), projects: [...new Set(stats.groups.map((g) => g.projectId))] };
  };
  const ownerSees = await questionsAs(s.owner.user);
  const morganSees = await questionsAs(s.morgan.user);
  const danaSees = await questionsAs(s.dana.user);
  const leadSees = await questionsAs(s.lead.user);
  check('questions: an Owner counts every question, scope all', ownerSees.scope === 'all' && ownerSees.count === 5, ownerSees);
  check('questions: a member counts questions on projects they can open, never on another project or between others on none', morganSees.scope === 'projects'
    && morganSees.count === 2 && morganSees.projects.every((p) => p === s.apex), morganSees);
  check('questions: and the questions asked to them on no project', danaSees.count === 3 && danaSees.projects.includes(null), danaSees);
  check('questions: agents.manage counts questions on no project, but not projects it cannot open', leadSees.scope === 'all' && leadSees.count === 2
    && leadSees.projects.every((p) => p === null), leadSees);
  await actAs(db, s.morgan.user);
  const rawMorgan = await s.q('SELECT 1 FROM pm.questions');
  await actAs(db, null);
  await db.exec('RESET ROLE');
  check('questions: the server count never exceeds what the projects allow (row access gives the member the same here)', rawMorgan.length === morganSees.count, rawMorgan.length);

  // --- Labels in analytics -------------------------------------------------------------------
  const byLabel = Object.fromEntries(breakdown(v2Model.facts, 'label', labels).map((r) => [r.label, r.group.sums]));
  check('labels: usage with two labels counts on both rows', byLabel['client:acme']?.tokensIn === 3000 && byLabel.deploy?.tokensIn === 1000, byLabel);
  check('labels: pull requests and host failures carry their event\'s labels', byLabel['client:acme']?.prOpened === 1 && byLabel.deploy?.prMerged === 1 && byLabel.nightly?.incident === 1, byLabel);
  check('labels: everything else sits on the No label row', (byLabel[NO_LABEL]?.run ?? 0) === v2Model.totals.sums.run, byLabel[NO_LABEL]);
  const acme = buildAgentAnalytics(base({ activities: v2.rows, runs: feed, selectedLabels: new Set(['client:acme']) }));
  check('labels: the filter keeps only facts with the label', acme.totals.sums.tokensIn === 3000 && acme.totals.sums.run === 0 && acme.totals.sums.prOpened === 1, acme.totals.sums);

  // --- Provider plans -------------------------------------------------------------------------
  const plans = [{ provider: 'Anthropic', monthlyCostUsd: 100, seats: 2 }];
  const withPlan = buildAgentAnalytics(base({ activities: v2.rows, runs: feed, providerPlans: plans }));
  check('plans: measured cost is the same with or without a plan', close(withPlan.totals.sums.costUsd, v2Model.totals.sums.costUsd)
    && JSON.stringify(withPlan.totals.sums) === JSON.stringify(v2Model.totals.sums));
  check('plans: the monthly cost is per seat times seats', withPlan.subscription?.monthlyUsd === 200, withPlan.subscription);
  const days = 3;
  check('plans: the whole selection takes the whole range\'s share', close(withPlan.subscription?.estimateUsd ?? -1, 200 * (12 / 365) * days), withPlan.subscription);
  const apexOnly = buildAgentAnalytics(base({ activities: v2.rows, runs: feed, providerPlans: plans, selectedProjectIds: new Set([s.apex]) }));
  const anthropicUnpriced = v2Model.facts.filter((f) => f.kind === 'unpricedTokens' && f.provider === 'anthropic').reduce((n, f) => n + f.value, 0);
  check('plans: a slice takes its share of the provider\'s unpriced tokens', close(apexOnly.subscription?.estimateUsd ?? -1, 200 * (12 / 365) * days * (2210 / anthropicUnpriced)),
    [apexOnly.subscription, anthropicUnpriced]);
  check('plans: no plan, no estimate', v2Model.subscription === null && subscriptionEstimate([], [], [], 3) === null);
  check('plans: the words say estimate and keep it apart', /estimate/.test(ESTIMATE_LABEL) && /not in model cost/.test(ESTIMATE_LABEL) && SUBSCRIPTION_LABEL === 'Subscription cost');
  await actAs(db, s.owner.user);
  const ownerWrite = await db.query("INSERT INTO pm.provider_plans (provider, monthly_cost_usd, seats) VALUES ('anthropic', 200, 1)").then(() => 'ok', (e: Error) => e.message);
  await actAs(db, s.morgan.user);
  const memberWrite = await db.query("INSERT INTO pm.provider_plans (provider, monthly_cost_usd, seats) VALUES ('openai', 20, 1)").then(() => 'ok', (e: Error) => e.message);
  const memberRead = await s.q('SELECT provider FROM pm.provider_plans');
  await actAs(db, null);
  await db.exec('RESET ROLE');
  check('plans: an Owner writes a plan, a member cannot but reads it', ownerWrite === 'ok' && memberWrite !== 'ok' && memberRead.length === 1, [ownerWrite, memberWrite, memberRead]);
}

/**
 * The app caches its service client on the first URL it sees, so both
 * databases are served through one address that forwards to the current one.
 */
let proxyTarget = '';
async function startProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const proxy = createServer((req, res) => {
    const target = new URL(proxyTarget);
    const forward = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, close: () => new Promise((resolve) => proxy.close(() => resolve())) };
}

async function main() {
  const proxy = await startProxy();
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: proxy.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', APP_ENCRYPTION_KEY: 'e'.repeat(64), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  proxyTarget = server.url;
  try {
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const labelsRoute = await import('../src/app/api/v1/agent-activities/[id]/labels/route');
    const exportRoute = await import('../src/app/api/v1/agent-events/export/route');
    const runsRoute = await import('../src/app/api/v1/agents/runs/route');
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
    const post = (apiKey: string, body: unknown) => call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, apiKey, body);
    const editLabels = (apiKey: string, id: string, body: unknown) => call(labelsRoute.POST, 'POST', `/api/v1/agent-activities/${id}/labels`, { id }, apiKey, body);
    const exportPage = (apiKey: string, query = '') => call(exportRoute.GET, 'GET', `/api/v1/agent-events/export${query}`, {}, apiKey);
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;

    // --- Labels on ingest ---------------------------------------------------------------------
    const claimed = await post(s.keys.builder, { activity_type: 'work.claimed', payload: { task_title: 'Checkout' }, labels: ['client:acme', 'deploy', 'client:acme'] });
    check('labels: a typed event takes labels, duplicates collapsed, payload untouched', claimed.status === 201
      && JSON.stringify(claimed.body.data?.labels) === '["client:acme","deploy"]' && JSON.stringify(claimed.body.data.metadata) === '{"task_title":"Checkout"}'
      && claimed.body.data.title === 'Claimed: Checkout', claimed.body);
    const note = await post(s.keys.builder, { activity_type: 'note', payload: { title: 'Read the logs' }, labels: ['ops'] });
    const legacy = await post(s.keys.builder, { activity_type: 'heartbeat', title: 'Up', labels: ['ops'] });
    check('labels: open and legacy events take them too', note.status === 201 && note.body.data?.labels?.[0] === 'ops' && legacy.status === 201 && legacy.body.data?.labels?.[0] === 'ops', [note.body, legacy.body]);
    const bad = await post(s.keys.builder, { activity_type: 'work.claimed', payload: { task_title: 'X' }, labels: ['Bad Label'] });
    const many = await post(s.keys.builder, { activity_type: 'work.claimed', payload: { task_title: 'X' }, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) });
    const long = await post(s.keys.builder, { activity_type: 'work.claimed', payload: { task_title: 'X' }, labels: [`a${'b'.repeat(64)}`] });
    check('labels: a malformed label, a 65-character one or more than 20 are 422', bad.status === 422 && many.status === 422 && long.status === 422, [bad.status, many.status, long.status]);
    const unlabelled = await post(s.keys.builder, { activity_type: 'work.done', payload: { task_title: 'Checkout' } });
    check('labels: an event sent without labels has none', unlabelled.status === 201 && JSON.stringify(unlabelled.body.data?.labels) === '[]', unlabelled.body);
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const mcp = await runTool(s.keys.builder, s.builder.id, 'log_activity', { activity_type: 'work.done', payload: { task_title: 'Over MCP' }, labels: ['mcp'] });
    check('labels: MCP log_activity takes labels', mcp?.ok === true && mcp.data?.labels?.[0] === 'mcp', mcp);
    let mcpBad = '';
    try { PM_TOOLS.find((t) => t.name === 'log_activity')!.input.parse({ activity_type: 'work.done', payload: { task_title: 'x' }, labels: ['NOPE'] }); } catch (error) { mcpBad = (error as Error).message; }
    check('labels: MCP refuses a malformed label', mcpBad !== '', mcpBad);

    // --- Labels after the fact ----------------------------------------------------------------
    const id = claimed.body.data.id as string;
    const own = await editLabels(s.keys.builder, id, { add: ['reviewed'], remove: ['deploy'] });
    check('labels: the event\'s own agent adds and removes', own.status === 200 && JSON.stringify(own.body.data?.labels) === '["client:acme","reviewed"]', own.body);
    const other = await editLabels(s.keys.planner, id, { add: ['mine'] });
    check('labels: another agent\'s event is 404', other.status === 404, other.body);
    const manager = await editLabels(s.keys.owner, id, { add: ['audited'] });
    check('labels: agents.manage edits any event', manager.status === 200 && manager.body.data?.labels?.includes('audited'), manager.body);
    const person = await editLabels(s.keys.morgan, id, { add: ['x'] });
    check('labels: a key with neither scope is 403', person.status === 403, person.body);
    const tooMany = await editLabels(s.keys.builder, id, { add: Array.from({ length: 18 }, (_, i) => `x${i}`) });
    check('labels: more than 20 after the edit is 422 too_many_labels, nothing changed', tooMany.status === 422 && reason(tooMany) === 'too_many_labels'
      && (await s.q<{ labels: string[] }>('SELECT labels FROM pm.agent_activities WHERE id = $1', [id]))[0].labels.length === 3, tooMany.body);
    const empty = await editLabels(s.keys.builder, id, {});
    const missing = await editLabels(s.keys.builder, randomUUID(), { add: ['x'] });
    check('labels: an empty edit is 422, an unknown event 404', empty.status === 422 && missing.status === 404, [empty.status, missing.status]);
    const listed = await call(activitiesRoute.GET, 'GET', '/api/v1/agent-activities?label=reviewed', {}, s.keys.owner);
    check('labels: GET lists by label', listed.status === 200 && listed.body.data.length === 1 && listed.body.data[0].id === id, listed.body);

    // --- Provider on ingest and runs ----------------------------------------------------------
    const oldUsage = { source_usage_id: 'live-1', model: 'claude-opus', input_tokens: 10, output_tokens: 2, cost_usd: 0.01, recorded_at: '2026-11-24T10:00:00+00:00' };
    const oldPosted = await post(s.keys.builder, { activity_type: 'usage.recorded', payload: oldUsage });
    check('provider: an old usage payload is stored exactly as before (no provider key)', oldPosted.status === 201
      && canon(oldPosted.body.data?.metadata ?? {}) === canon({ ...oldUsage, cached_tokens: 0 }) && oldPosted.body.data.title === 'Recorded 12 tokens for claude-opus', oldPosted.body);
    const withProvider = await post(s.keys.builder, { activity_type: 'usage.recorded', payload: { ...oldUsage, source_usage_id: 'live-2', provider: 'anthropic' } });
    check('provider: usage.recorded keeps provider', withProvider.status === 201 && withProvider.body.data?.metadata?.provider === 'anthropic', withProvider.body);
    const oldTurn = { source_turn_id: 'live-t', origin: 'scheduled', duration_ms: 1000, started_at: '2026-11-24T10:00:00+00:00', finished_at: '2026-11-24T10:00:01+00:00', outcome: 'work' };
    const turnPosted = await post(s.keys.builder, { activity_type: 'turn.completed', payload: oldTurn });
    check('provider: a turn.completed is stored exactly as before', turnPosted.status === 201 && canon(turnPosted.body.data?.metadata ?? {}) === canon(oldTurn)
      && turnPosted.body.data.title === 'Ran 1s (scheduled)', turnPosted.body);
    const started = await call(runsRoute.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.planner, { title: 'With provider', model: 'gpt-x', provider: 'openai' });
    const storedProvider = started.body.data?.id ? (await s.q<{ provider: string }>('SELECT provider FROM pm.agent_runs WHERE id = $1', [started.body.data.id]))[0]?.provider : null;
    check('provider: a run takes provider, and its answer has the same fields as before', started.status === 201 && storedProvider === 'openai' && !('provider' in started.body.data), [started.body, storedProvider]);
    const mcpRun = await runTool(s.keys.planner, s.planner.id, 'start_run', { title: 'MCP provider', provider: 'google', idempotency_key: randomUUID() });
    check('provider: MCP start_run takes provider', mcpRun?.ok === true
      && (await s.q<{ provider: string }>('SELECT provider FROM pm.agent_runs WHERE id = $1', [mcpRun.data.id]))[0]?.provider === 'google', mcpRun);

    // --- Export ---------------------------------------------------------------------------------
    const denied = await exportPage(s.keys.builder);
    check('export: needs agent_events.export', denied.status === 403, denied.body);
    const badCursor = await exportPage(s.keys.owner, '?since_cursor=nope');
    const badLimit = await exportPage(s.keys.owner, '?limit=5000');
    check('export: a cursor it did not give out, or a limit over 1000, is 400', badCursor.status === 400 && badLimit.status === 400, [badCursor.body, badLimit.body]);
    const total = Number((await s.q<{ n: number }>('SELECT (SELECT count(*) FROM pm.agent_activities) + (SELECT count(*) FROM pm.agent_runs) AS n'))[0].n);
    const seen = new Map<string, number>();
    let cursor = '';
    let pages = 0;
    let insertedBetween = 0;
    const between: string[] = [];
    for (;;) {
      const page = await exportPage(s.keys.owner, `?limit=4${cursor ? `&since_cursor=${cursor}` : ''}`);
      if (page.status !== 200) { check('export: a page answers', false, page.body); break; }
      pages += 1;
      for (const row of page.body.data) seen.set(`${row.source}:${row.id}`, (seen.get(`${row.source}:${row.id}`) ?? 0) + 1);
      cursor = page.body.meta.next_cursor;
      if (!page.body.meta.has_more || pages > 200) break;
      // New events arrive between pages.
      if (pages <= 3) {
        const added = await post(s.keys.planner, { activity_type: 'work.claimed', payload: { task_title: `Between ${pages}` } });
        between.push(added.body.data.id);
        insertedBetween += 1;
      }
    }
    const dupes = [...seen.values()].filter((n) => n > 1).length;
    check('export: every event and run once, none twice, across pages with inserts between them', seen.size === total + insertedBetween && dupes === 0, { seen: seen.size, total, insertedBetween, dupes });
    check('export: the rows inserted between pages arrived', between.every((b) => seen.has(`activity:${b}`)));
    const rowShape = (await exportPage(s.keys.owner, '?limit=1000&types=work.claimed')).body.data.find((r: Loose) => r.id === id);
    check('export: the stable row shape', rowShape && ['id', 'seq', 'source', 'occurred_at', 'agent_id', 'type', 'labels', 'title', 'payload', 'project_id', 'task_id', 'run_id', 'principal_id']
      .every((k) => k in rowShape) && rowShape.type === 'work.claimed' && rowShape.labels.includes('reviewed'), rowShape);

    // A label edit moves the row forward: the next page sends it again with its labels.
    await editLabels(s.keys.builder, id, { add: ['exported'] });
    const again = await exportPage(s.keys.owner, `?since_cursor=${cursor}`);
    check('export: an edited event comes again after the cursor, with its new labels', again.body.data.length === 1 && again.body.data[0].id === id
      && again.body.data[0].labels.includes('exported'), again.body.data);
    cursor = again.body.meta.next_cursor;
    const idle = await exportPage(s.keys.owner, `?since_cursor=${cursor}`);
    check('export: nothing new, nothing sent, the cursor holds', idle.body.data.length === 0 && idle.body.meta.next_cursor === cursor && idle.body.meta.has_more === false, idle.body);

    // A row that took its number early but committed after the cursor passed it.
    await db.exec('RESET ROLE');
    const lateSeq = 2;
    const lastSeq = Number(cursor.split('.')[2]);
    await db.exec('ALTER TABLE pm.agent_activities DISABLE TRIGGER stamp_agent_event_change');
    const lateId = (await s.q<{ id: string }>(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata, seq, change_txid)
      VALUES ($1, 'work.done', 'Finished: late', '{"task_title":"late"}', $2, pg_current_xact_id()::text::bigint) RETURNING id`, [s.builder.id, lateSeq]))[0].id;
    await db.exec('ALTER TABLE pm.agent_activities ENABLE TRIGGER stamp_agent_event_change');
    const late = await exportPage(s.keys.owner, `?since_cursor=${cursor}`);
    check('export: a row committed late with a lower seq still arrives after the cursor (seq alone would skip it)', lateSeq < lastSeq
      && late.body.data.some((r: Loose) => r.id === lateId), { lateSeq, lastSeq, data: late.body.data });
    cursor = late.body.meta.next_cursor;

    // A row in a transaction still open waits; once committed, it comes.
    const [txid, seqAt] = cursor.split('.').slice(1);
    await db.exec('BEGIN');
    const openId = (await s.q<{ id: string }>(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'work.done', 'Finished: open', '{"task_title":"open"}') RETURNING id`, [s.builder.id]))[0].id;
    const during = await s.q<Loose>('SELECT event FROM pm.agent_event_export($1, $2, 100)', [txid, seqAt]);
    await db.exec('COMMIT');
    const afterCommit = await s.q<Loose>('SELECT event FROM pm.agent_event_export($1, $2, 100)', [txid, seqAt]);
    check('export: a row in an open transaction waits until it commits', !during.some((r) => r.event.id === openId) && afterCommit.some((r) => r.event.id === openId),
      [during.length, afterCommit.length]);

    // Filters and project scope.
    const builderOnly = await exportPage(s.keys.owner, `?limit=1000&agents=${s.builder.id}&types=work.claimed,run`);
    check('export: agents and types filter', builderOnly.body.data.length > 0 && builderOnly.body.data.every((r: Loose) => r.agent_id === s.builder.id && ['work.claimed', 'run'].includes(r.type)), builderOnly.body.data.length);
    const runsOnly = await exportPage(s.keys.owner, '?limit=1000&types=run');
    check('export: type run exports runs, with their provider', runsOnly.body.data.length > 0 && runsOnly.body.data.every((r: Loose) => r.source === 'run')
      && runsOnly.body.data.some((r: Loose) => r.payload.provider === 'openai'), runsOnly.body.data.length);
    await s.q("INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata) VALUES ($1, $2, 'work.done', 'Finished: zenith', '{\"task_title\":\"zenith\"}')", [s.builder.id, s.zenith]);
    await s.q("INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata) VALUES ($1, $2, 'work.done', 'Finished: apex', '{\"task_title\":\"apex\"}')", [s.builder.id, s.apex]);
    const limited = await exportPage(s.keys.dana, '?limit=1000');
    check('export: a key without projects.read_all exports only its projects', limited.status === 200 && limited.body.data.length > 0
      && limited.body.data.every((r: Loose) => r.project_id === s.apex), limited.body.data?.map((r: Loose) => r.project_id));

    // --- Webhook agent_event.created ----------------------------------------------------------
    await db.exec('RESET ROLE');
    const eventsOf = async () => s.q<Loose>("SELECT e.id, e.resource_id, e.payload, (SELECT array_agg(d.endpoint_id) FROM pm.webhook_deliveries d WHERE d.webhook_event_id = e.id) AS endpoints FROM pm.webhook_events e WHERE e.event_type = 'agent_event.created'");
    check('webhook: nothing is written while no endpoint subscribes', (await eventsOf()).length === 0);
    const runHook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Runs', 'https://hooks.example.test/runs', 'whsec_r', '{run.started}') RETURNING id`))[0].id;
    await post(s.keys.builder, { activity_type: 'work.done', payload: { task_title: 'No subscriber' } });
    check('webhook: an endpoint on other events does not get agent events', (await eventsOf()).length === 0, runHook);
    const builderHook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id, agent_event_types)
      VALUES ('Builder done', 'https://hooks.example.test/b', 'whsec_b', '{agent_event.created}', $1, '{work.done}') RETURNING id`, [s.builder.id]))[0].id;
    const allHook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Warehouse', 'https://hooks.example.test/w', 'whsec_w', '{agent_event.created}') RETURNING id`))[0].id;
    const done = await post(s.keys.builder, { activity_type: 'work.done', payload: { task_title: 'Hooked' }, labels: ['deploy'] });
    await post(s.keys.builder, { activity_type: 'work.claimed', payload: { task_title: 'Claim' } });
    await post(s.keys.planner, { activity_type: 'work.done', payload: { task_title: 'Planner done' } });
    const hooked = await eventsOf();
    const forDone = hooked.filter((e) => e.resource_id === done.body.data.id);
    check('webhook: once per event, to each matching endpoint once', forDone.length === 1 && forDone[0].endpoints.length === 2
      && forDone[0].endpoints.includes(builderHook) && forDone[0].endpoints.includes(allHook), forDone);
    check('webhook: the agent and type filters hold (the builder hook gets only its own work.done)', hooked.length === 3
      && hooked.filter((e) => e.endpoints.includes(builderHook)).length === 1 && hooked.every((e) => e.endpoints.includes(allHook)), hooked.map((e) => e.endpoints));
    const exported = (await exportPage(s.keys.owner, '?limit=1000&types=work.done')).body.data.find((r: Loose) => r.id === done.body.data.id);
    const sent = forDone[0]?.payload?.data?.agent_event;
    check('webhook: the payload carries the export\'s row, with labels and member_ids', sent && JSON.stringify({ ...sent, occurred_at: iso(sent.occurred_at) }) === JSON.stringify({ ...exported, occurred_at: iso(exported.occurred_at) })
      && sent.labels[0] === 'deploy' && forDone[0].payload.data.member_ids[0] === s.builder.id && forDone[0].payload.type === 'agent_event.created', [sent, exported]);
    await s.q("UPDATE pm.webhook_endpoints SET is_active = false WHERE id IN ($1, $2)", [builderHook, allHook]);
    await post(s.keys.builder, { activity_type: 'work.done', payload: { task_title: 'Paused' } });
    check('webhook: a paused endpoint gets nothing', (await eventsOf()).length === 3);

    // --- Analytics (database functions and the model) ----------------------------------------
    await analyticsChecks(s, db);
  } finally {
    await server.close();
    await db.close();
    await proxy.close();
  }

  console.log(`agent event pipeline: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
