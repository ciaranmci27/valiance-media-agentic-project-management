/**
 * Live template runs (20261126000300_template_reflow_drafts.sql), over the
 * real routes and services (session routes with a signed-in member, v1 routes
 * with keys, MCP tools through routeCaller, a fake PostgREST over PGlite with
 * the full schema):
 * - The migration, run twice on the schema before it, matches schema.sql
 *   (fresh equals upgraded); a run recorded the 2.0.46 way still records;
 *   drafts and the reflow function are server only.
 * - Reflow: untouched tasks move by key date plus offset; a hand-changed one
 *   is kept unless opted in; done and trashed tasks are ignored; a new date
 *   before today is warned about; dry_run writes nothing; the initiative's
 *   target follows the main key date only while untouched; moved tasks get
 *   their new planned date; the change is logged in the team activity log as
 *   the caller; a run without an initiative is not live; an agent moves only
 *   what it may edit.
 * - Drafts: an agent whose create policy is approval (403 on run) drafts; an
 *   approval is created, asked_to the template's owner; the draft's preview
 *   marks added and removed steps; nothing is made before approval; the same
 *   idempotency_key answers the same draft (REST and MCP); a person approves
 *   in the session and the tasks are made as them with "drafted by" on the
 *   run and its initiative; a second approve is 409; an agent named in the
 *   approval cannot approve, nor a personal agent for its person; an added
 *   step's assignee is checked against the approver's own rights; reject (a
 *   person's own key); approving and rejecting the approval card decides the
 *   draft; an expired or withdrawn approval expires the draft; a template
 *   changed since is reported and the draft makes what it saw; a run recorded
 *   before its read back failed keeps the draft approved with that run (a
 *   retry is 409, nothing twice); a template in Trash at approve time is 404
 *   template_not_found, not 403 not_asked; the approval's decision is
 *   recorded before the draft is claimed or any task made, so an approval
 *   cancelled while the run is checked is 409 with nothing made and the draft
 *   expired; a run that fails before it is recorded reopens the approval.
 * - The initiative read (session, v1, MCP) names the template run that made
 *   it: template, labelled key dates, who ran it; null for one made by hand.
 *
 *   npm run -s test:template-drafts
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261126000300_template_reflow_drafts.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- TEMPLATE REFLOW AND DRAFTS (20261126000300_template_reflow_drafts.sql)\n-- ============================================================\n';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; headers: Headers };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOGINS = {
  owner: { id: id(3101), email: 'olivia@studio.example' },
  morgan: { id: id(3102), email: 'morgan@studio.example' },
  nina: { id: id(3103), email: 'nina@studio.example' },
};
let signedIn = LOGINS.owner;
/** Armed by a check: the next read of one run by id fails, as a read back after the run is recorded would. */
let failNextRunRead = false;
/** Armed by a check: the next call recording a template run fails before anything is recorded. */
let failNextRunRecord = false;
/** Armed by a check: runs once, before the next request matching it is served (a race in the window). */
let beforeRequest: { match: (request: IncomingMessage, url: URL) => boolean; run: () => Promise<unknown> } | null = null;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (beforeRequest && beforeRequest.match(request, url)) {
      const armed = beforeRequest;
      beforeRequest = null;
      await armed.run();
    }
    if (failNextRunRecord && request.method === 'POST' && url.pathname.endsWith('/rpc/record_task_template_run')) {
      failNextRunRecord = false;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'XX000', message: 'record failed (test)', details: null, hint: null }));
      return true;
    }
    if (failNextRunRead && request.method === 'GET' && url.pathname.endsWith('/task_template_runs') && url.searchParams.has('id')) {
      failNextRunRead = false;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'XX000', message: 'read failed (test)', details: null, hint: null }));
      return true;
    }
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-26T00:00:00Z' }));
      return true;
    }
    return false;
  };
}

function installSession(supabaseUrl: string) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const store = {
    getAll: () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-26T00:00:00Z' };
      const session = {
        access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: signedIn.id, email: signedIn.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
        refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp, user,
      };
      return [{ name, value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }];
    },
    get: (key: string) => store.getAll().find((cookie) => cookie.name === key),
    set: () => undefined,
  };
  const nextHeaders = createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> };
  nextHeaders.cookies = async () => store;
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(join(__dirname, '..', 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  const tpl = (await old.query<{ id: string }>(`INSERT INTO pm.task_templates (name, items) VALUES ('Old', '[{"title":"Upload","due_in_days":3}]') RETURNING id`)).rows[0].id;
  const project = (await old.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id")).rows[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  // 2.0.46 records its runs through record_task_template_run, unchanged.
  const recorded = await old.query<{ id: string }>(`SELECT pm.record_task_template_run($1::jsonb, '[]'::jsonb) AS id`, [JSON.stringify({
    template_id: tpl, template_version: 1, snapshot: { name: 'Old' }, project_id: project, via: 'api', start_date: '2026-12-01', key_dates: { start: '2026-12-01' },
  })]).then((r) => r.rows[0]?.id, (e: Error) => e.message);
  check('compatibility: a run recorded the 2.0.46 way still records after the migration', typeof recorded === 'string' && /^[0-9a-f-]{36}$/.test(recorded), recorded);
  await old.close();

  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const grants = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'pm' AND table_name = 'task_template_run_drafts' AND grantee IN ('anon', 'authenticated')`))[0].n;
  const fnGrant = (await q<{ ok: boolean }>(`SELECT has_function_privilege('authenticated', 'pm.reflow_task_template_run(uuid, jsonb, jsonb, date, jsonb, jsonb)', 'EXECUTE') AS ok`))[0].ok;
  check('database: drafts and the reflow function are server only', grants === 0 && fnGrant === false, { grants, fnGrant });
  const status = await fresh.query(`INSERT INTO pm.task_template_run_drafts (template_id, template_version, snapshot, project_id, proposal, status)
    SELECT $1, 1, '{}', $2, '{}', 'maybe'`, [id(1), id(2)]).then(() => null, (e: Error) => e.message);
  check('database: a draft status is pending, approved, rejected or expired', /status_check|foreign key/.test(status ?? ''), status);
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  // Assistants on: a personal agent's writes are on hold while they are off (the 423 gate, 20261127000100).
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const memberId = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@studio.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    return memberId;
  };
  const grant = (memberId: string, keys: string[], channel = 'api') => q(
    `INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
     SELECT $1, key, $3, 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, keys, channel]);
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const nina = await member('Nina', 'member', LOGINS.nina);
  const atlas = await member('Atlas', 'agent');
  const rex = await member('Rex', 'agent');
  // Olivia's personal agent.
  const pia = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ('Pia', 'pia@agents.invalid', 'agent', $1, 'personal-assistant') RETURNING id", [owner]))[0].id;
  // Morgan manages projects (not every task); Atlas needs approval for its new tasks.
  await grant(morgan, ['projects.manage'], 'app');
  await grant(morgan, ['projects.manage'], 'api');
  await q("UPDATE pm.team_members SET agent_create_policy = 'approval' WHERE id = $1", [atlas]);
  const AGENT = ['tasks.create', 'tasks.read', 'projects.read', 'tasks.manage_assigned'];
  for (const agent of [atlas, rex]) await grant(agent, AGENT);
  await grant(pia, [...AGENT, 'approvals.decide']);
  const launches = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Launches') RETURNING id"))[0].id;
  for (const m of [morgan, nina, atlas, rex]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [launches, m]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [sha(secret), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['tasks.create', 'tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all', 'templates.manage', 'approvals.decide']),
    atlas: await key(atlas, AGENT),
    rex: await key(rex, AGENT),
    pia: await key(pia, [...AGENT, 'approvals.decide']),
  };
  // A launch playbook Morgan owns: key dates, roles (the writer has a default), a fill-in.
  const template = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, created_by, fields, key_dates, roles, items) VALUES ('Launch plan', $1, $2, $3, $4, $5) RETURNING id`, [
    morgan,
    JSON.stringify([{ key: 'product', label: 'Product' }]),
    JSON.stringify([{ key: 'kickoff', label: 'Kickoff' }, { key: 'launch', label: 'Launch date', main: true }]),
    JSON.stringify([{ key: 'designer', label: 'Designer', required: true }, { key: 'writer', label: 'Writer', default_member_id: nina }]),
    JSON.stringify([
      { key: 'brief', title: 'Brief for {product}', anchor: 'kickoff', due_in_days: 2 },
      { key: 'assets', title: 'Assets for {product}', role: 'designer', anchor: 'launch', due_in_days: -14, subtasks: [{ key: 'assets.social', title: 'Social cards', anchor: 'launch', due_in_days: -12 }] },
      { key: 'copy', title: 'Copy for {product}', role: 'writer', anchor: 'launch', due_in_days: -7, depends_on: ['assets'] },
      { key: 'ship', title: 'Ship {product}', anchor: 'launch', due_in_days: 0, depends_on: ['copy'] },
      { key: 'retro', title: 'Retro on {product}', anchor: 'launch', due_in_days: 14 },
    ]),
  ]))[0].id;
  return { q, owner, morgan, nina, atlas, rex, pia, launches, template, keys };
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  try {
    const runRoute = await import('../src/app/api/workspace/task-templates/[id]/run/route');
    const reflowRoute = await import('../src/app/api/workspace/task-templates/runs/[runId]/reflow/route');
    const draftRoute = await import('../src/app/api/workspace/task-templates/[id]/drafts/route');
    const draftOne = await import('../src/app/api/workspace/task-templates/drafts/[draftId]/route');
    const draftList = await import('../src/app/api/workspace/task-templates/drafts/route');
    const approveRoute = await import('../src/app/api/workspace/task-templates/drafts/[draftId]/approve/route');
    const answerRoute = await import('../src/app/api/workspace/questions/[id]/answer/route');
    const v1Run = await import('../src/app/api/v1/task-templates/[id]/run/route');
    const v1Draft = await import('../src/app/api/v1/task-templates/[id]/drafts/route');
    const v1DraftOne = await import('../src/app/api/v1/task-templates/drafts/[draftId]/route');
    const v1Approve = await import('../src/app/api/v1/task-templates/drafts/[draftId]/approve/route');
    const v1Reject = await import('../src/app/api/v1/task-templates/drafts/[draftId]/reject/route');
    const v1Reflow = await import('../src/app/api/v1/task-templates/runs/[runId]/reflow/route');
    const initiativeRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/[initiativeId]/route');
    const v1Initiative = await import('../src/app/api/v1/projects/[id]/initiatives/[initiativeId]/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const tasks = () => count('SELECT count(*)::int AS n FROM pm.tasks');
    const day = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? '')).slice(0, 10) || null;
    const dueOf = async (taskId: string) => day((await s.q<Loose>('SELECT due_date FROM pm.tasks WHERE id = $1', [taskId]))[0]?.due_date);
    const T = s.template;

    // ══ Reflow ═══════════════════════════════════════════════════════════
    as(LOGINS.owner);
    const runInput = {
      project_id: s.launches, key_dates: { kickoff: '2027-02-01', launch: '2027-03-01' }, roles: { designer: s.nina }, values: { product: 'Aurora' }, create_initiative: true,
    };
    const ran = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${T}/run`, { id: T }, runInput);
    const runId = ran.body?.data?.run?.id as string;
    const initiativeId = ran.body?.data?.initiative?.id as string;
    check('reflow setup: a run with an initiative', ran.status === 201 && !!runId && !!initiativeId, ran.body);
    const links = await s.q<Loose>('SELECT task_id, item_key FROM pm.task_template_run_tasks WHERE run_id = $1', [runId]);
    const task = Object.fromEntries(links.map((l) => [l.item_key, l.task_id as string]));
    // The retro is done, the copy is in Trash, someone moved the ship date by hand.
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [task.retro]);
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [task.copy]);
    await s.q("UPDATE pm.tasks SET due_date = '2027-03-03' WHERE id = $1", [task.ship]);
    const activities = () => count("SELECT count(*)::int AS n FROM pm.activities WHERE type = 'initiative.key_dates'");

    const before = { assets: await dueOf(task.assets), social: await dueOf(task['assets.social']), activity: await activities() };
    const dry = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { launch: '2027-03-08' }, dry_run: true });
    const d = dry.body?.data;
    const movedKeys = (d?.moved ?? []).map((m: Loose) => m.item_key).sort().join();
    check('reflow: moves untouched tasks by key date plus offset (assets, its subtask)', dry.status === 200 && movedKeys === 'assets,assets.social'
      && d.moved.find((m: Loose) => m.item_key === 'assets')?.to === '2027-02-22' && d.moved.find((m: Loose) => m.item_key === 'assets.social')?.to === '2027-02-24', d);
    check('reflow: a hand-changed task is kept (hand_changed, can opt in)', d?.kept?.length === 1 && d.kept[0].item_key === 'ship' && d.kept[0].reason === 'hand_changed'
      && d.kept[0].can_include === true && d.kept[0].from === '2027-03-03' && d.kept[0].to === '2027-03-08', d?.kept);
    check('reflow: done and trashed tasks are ignored', (d?.ignored ?? []).map((i: Loose) => `${i.item_key}:${i.reason}`).sort().join() === 'copy:trashed,retro:done', d?.ignored);
    check('reflow: a task whose key date did not change is left alone (the brief counts from kickoff)', d?.unchanged === 1 && !(d.moved ?? []).some((m: Loose) => m.item_key === 'brief'), d?.unchanged);
    check('reflow: the initiative target follows the main key date', d?.initiative?.follows === true && d.initiative.from === '2027-03-01' && d.initiative.to === '2027-03-08', d?.initiative);
    check('reflow: dry run writes nothing', await dueOf(task.assets) === before.assets && await dueOf(task['assets.social']) === before.social && await activities() === before.activity
      && (await s.q<Loose>('SELECT key_dates FROM pm.task_template_runs WHERE id = $1', [runId]))[0].key_dates.launch === '2027-03-01'
      && day((await s.q<Loose>('SELECT target_date FROM pm.initiatives WHERE id = $1', [initiativeId]))[0].target_date) === '2027-03-01', before);
    const past = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { kickoff: '2020-01-06' }, dry_run: true });
    check('reflow: a new date before today is warned about (the key date and each task)', past.status === 200 && past.body.data.warnings.some((w: Loose) => w.code === 'date_in_past' && w.key_date === 'kickoff')
      && past.body.data.warnings.some((w: Loose) => w.code === 'date_in_past' && w.task_id === task.brief && w.date === '2020-01-08'), past.body?.data?.warnings);
    const unknown = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { golive: '2027-03-01' }, dry_run: true });
    check('reflow: an unknown key date is refused at its path', unknown.status === 422 && unknown.body?.error?.details?.errors?.[0]?.path === 'key_dates.golive', unknown.body);

    const applied = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { launch: '2027-03-08' } });
    const planned = async (taskId: string) => day((await s.q<Loose>('SELECT planned_due_date FROM pm.task_template_run_tasks WHERE task_id = $1', [taskId]))[0]?.planned_due_date);
    check('reflow: applied, untouched tasks move and get their new planned date', applied.status === 200 && applied.body.data.moved.length === 2
      && await dueOf(task.assets) === '2027-02-22' && await planned(task.assets) === '2027-02-22' && await dueOf(task['assets.social']) === '2027-02-24', applied.body);
    check('reflow: applied, the hand-changed, done and trashed tasks stay as they were', await dueOf(task.ship) === '2027-03-03' && await planned(task.ship) === '2027-03-01'
      && await dueOf(task.retro) === '2027-03-15' && await dueOf(task.copy) === '2027-02-22');
    const runAfter = (await s.q<Loose>('SELECT key_dates, start_date FROM pm.task_template_runs WHERE id = $1', [runId]))[0];
    check('reflow: the run keeps its new key dates; the initiative target moved', runAfter.key_dates.launch === '2027-03-08' && runAfter.key_dates.kickoff === '2027-02-01'
      && day((await s.q<Loose>('SELECT target_date FROM pm.initiatives WHERE id = $1', [initiativeId]))[0].target_date) === '2027-03-08', runAfter);
    const logged = await s.q<Loose>("SELECT user_id, entity_id, metadata FROM pm.activities WHERE type = 'initiative.key_dates' ORDER BY created_at DESC LIMIT 1");
    check('reflow: the key date change is logged in the team activity log as the caller', logged.length === 1 && logged[0].user_id === s.owner && logged[0].entity_id === initiativeId
      && logged[0].metadata.from.launch === '2027-03-01' && logged[0].metadata.to.launch === '2027-03-08' && logged[0].metadata.run_id === runId, logged);

    const optIn = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { launch: '2027-03-10' }, include_task_ids: [task.ship] });
    check('reflow: an opted-in hand-changed task moves too, with its new planned date', optIn.status === 200 && optIn.body.data.kept.length === 0
      && await dueOf(task.ship) === '2027-03-10' && await planned(task.ship) === '2027-03-10' && await dueOf(task.assets) === '2027-02-24', optIn.body?.data);
    // Someone set the initiative's target by hand: it stays.
    await s.q("UPDATE pm.initiatives SET target_date = '2027-04-01' WHERE id = $1", [initiativeId]);
    const handTarget = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { launch: '2027-03-12' } });
    check('reflow: an initiative target changed by hand stays', handTarget.status === 200 && handTarget.body.data.initiative?.follows === false
      && day((await s.q<Loose>('SELECT target_date FROM pm.initiatives WHERE id = $1', [initiativeId]))[0].target_date) === '2027-04-01', handTarget.body?.data?.initiative);
    const badInclude = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${runId}/reflow`, { runId }, { key_dates: { launch: '2027-03-12' }, include_task_ids: [id(9)], dry_run: true });
    check('reflow: include_task_ids names only the run\'s tasks (unknown_step at its path)', badInclude.status === 422 && reason(badInclude) === 'unknown_step'
      && badInclude.body.error.details.errors[0].path === 'include_task_ids[0]', badInclude.body);

    // The initiative's read names the run that made it (session, v1 and MCP), key dates labelled from the run's snapshot.
    const strip = (await session(initiativeRoute.GET, 'GET', `/api/workspace/projects/${s.launches}/initiatives/${initiativeId}`, { id: s.launches, initiativeId })).body?.data?.template_run;
    check('initiative read: template_run names the run that made it, its key dates labelled in the template order, the main one marked', strip?.run_id === runId
      && strip.template_id === T && strip.template_name === 'Launch plan' && strip.run_by_name === 'Olivia' && !!strip.created_at
      && JSON.stringify(strip.key_dates) === JSON.stringify([
        { key: 'kickoff', label: 'Kickoff', date: '2027-02-01', main: false },
        { key: 'launch', label: 'Launch date', date: '2027-03-12', main: true },
      ]), strip);
    const v1Strip = await v1(v1Initiative.GET, 'GET', `/api/v1/projects/${s.launches}/initiatives/${initiativeId}`, { id: s.launches, initiativeId }, s.keys.owner);
    const mcpStrip = await runTool(s.keys.owner, s.owner, 'get_initiative', { project_id: s.launches, initiative_id: initiativeId });
    check('initiative read (v1, MCP get_initiative): template_run too', v1Strip.status === 200 && v1Strip.body.data.template_run?.run_id === runId
      && mcpStrip.ok === true && mcpStrip.data.template_run?.run_id === runId, { v1: v1Strip.body?.data?.template_run, mcp: mcpStrip?.data?.template_run });
    const handMade = (await s.q<{ id: string }>("INSERT INTO pm.initiatives (project_id, name) VALUES ($1, 'By hand') RETURNING id", [s.launches]))[0].id;
    const noRun = await session(initiativeRoute.GET, 'GET', `/api/workspace/projects/${s.launches}/initiatives/${handMade}`, { id: s.launches, initiativeId: handMade });
    check('initiative read: an initiative no run made has template_run null', noRun.status === 200 && noRun.body.data.template_run === null, noRun.body?.data?.template_run);

    const plain = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${T}/run`, { id: T }, { ...runInput, values: { product: 'Plain' }, create_initiative: undefined });
    const plainRun = plain.body?.data?.run?.id as string;
    const notLive = await session(reflowRoute.POST, 'POST', `/api/workspace/task-templates/runs/${plainRun}/reflow`, { runId: plainRun }, { key_dates: { launch: '2027-03-08' } });
    check('reflow: a run without an initiative is not live (409 run_not_live)', notLive.status === 409 && reason(notLive) === 'run_not_live', notLive.body);
    // An agent moves only what it may edit (nothing here is assigned to it).
    const agentDry = await runTool(s.keys.rex, s.rex, 'reflow_template_run', { run_id: runId, key_dates: { launch: '2027-03-20' }, dry_run: true });
    check('reflow (MCP): an agent moves only what it may edit; the rest is kept (cannot_edit)', agentDry.ok === true && agentDry.data.moved.length === 0
      && agentDry.data.kept.length >= 3 && agentDry.data.kept.every((k: Loose) => k.reason === 'cannot_edit' && k.can_include === false), agentDry);
    const v1Dry = await v1(v1Reflow.POST, 'POST', `/api/v1/task-templates/runs/${runId}/reflow`, { runId }, s.keys.owner, { key_dates: { launch: '2027-03-20' }, dry_run: true });
    check('reflow (v1): a key with tasks.manage_all sees the full plan', v1Dry.status === 200 && v1Dry.body.data.moved.length === 3, v1Dry.body);

    // ══ Drafts ═══════════════════════════════════════════════════════════
    const draftInput = {
      project_id: s.launches,
      key_dates: { kickoff: '2027-05-03', launch: '2027-06-01' },
      roles: { designer: 'runner' },
      values: { product: 'Nova' },
      create_initiative: true,
      extra_steps: [{ title: 'Press kit for {product}', anchor: 'launch', due_in_days: -3 }],
      removed_steps: ['retro'],
      note: 'Launch date from the release plan; no retro for a minor launch.',
      idempotency_key: 'nova-draft-1',
    };
    const atlasRun = await v1(v1Run.POST, 'POST', `/api/v1/task-templates/${T}/run`, { id: T }, s.keys.atlas, { project_id: s.launches, key_dates: draftInput.key_dates, values: draftInput.values });
    check('drafts: an agent whose new tasks need approval cannot run a template (403 needs_approval)', atlasRun.status === 403 && reason(atlasRun) === 'needs_approval', atlasRun.body);
    const tasksBefore = await tasks();
    const drafted = await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, draftInput);
    const draft = drafted.body?.data;
    check('drafts: the agent drafts instead (201, pending, nothing made yet)', drafted.status === 201 && draft?.status === 'pending' && draft.proposed_by === s.atlas
      && await tasks() === tasksBefore, drafted.body);
    const approval = (await s.q<Loose>('SELECT * FROM pm.questions WHERE id = $1', [draft?.question_id]))[0];
    check('drafts: an approval is created through the approvals primitive, asked_to the template\'s owner', !!approval && approval.kind === 'approval' && approval.status === 'open'
      && approval.asked_to === s.morgan && approval.asked_by === s.atlas && approval.project_id === s.launches && approval.action?.type === 'template_run'
      && approval.action.details?.draft_id === draft.id && approval.question === draftInput.note && !!approval.expires_at, approval);
    const previewKeys = (draft?.preview?.tasks ?? []).map((t: Loose) => `${t.key}${t.change ? `:${t.change}` : ''}`).join();
    check('drafts: the preview marks the added step and lists the removed one', previewKeys === 'brief,assets,copy,ship,t5:added'
      && draft.preview.removed_tasks.length === 1 && draft.preview.removed_tasks[0].key === 'retro' && draft.preview.tasks[4].title === 'Press kit for Nova'
      && draft.preview.tasks[4].due_date === '2027-05-29' && draft.preview.template_changed_since === null, { previewKeys, preview: draft?.preview });
    const again = await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, draftInput);
    const mcpAgain = await runTool(s.keys.atlas, s.atlas, 'draft_template_run', { template_id: T, ...draftInput });
    check('drafts: the same idempotency_key answers the same draft (REST 200 and MCP), one draft, one approval', again.status === 200 && again.body.data.id === draft.id
      && mcpAgain.ok === true && mcpAgain.data.id === draft.id
      && await count('SELECT count(*)::int AS n FROM pm.task_template_run_drafts') === 1
      && await count("SELECT count(*)::int AS n FROM pm.questions WHERE kind = 'approval'") === 1, { again: again.body, mcp: mcpAgain });
    const badDraft = await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: undefined, removed_steps: ['nope'], extra_steps: [{ title: 'Call {client}' }] });
    check('drafts: a draft is checked like a run, each error at its own path (unknown_step, undeclared_field)', badDraft.status === 422
      && badDraft.body.error.details.errors.some((e: Loose) => e.path === 'removed_steps[0]' && e.code === 'unknown_step')
      && badDraft.body.error.details.errors.some((e: Loose) => e.path === 'extra_steps[0].title' && e.code === 'undeclared_field'), badDraft.body?.error);
    const mcpGet = await runTool(s.keys.atlas, s.atlas, 'get_template_run_draft', { draft_id: draft.id });
    const mcpList = await runTool(s.keys.atlas, s.atlas, 'list_template_run_drafts', { project_id: s.launches, status: 'pending' });
    check('drafts (MCP): the agent reads its draft and lists pending ones', mcpGet.ok && mcpGet.data.status === 'pending' && mcpList.ok && mcpList.data.some((x: Loose) => x.id === draft.id), { mcpGet, mcpList });

    // Morgan approves in the app.
    as(LOGINS.morgan);
    const approved = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft.id}/approve`, { draftId: draft.id }, {});
    const made = approved.body?.data?.run;
    const madeTasks = await s.q<Loose>(`SELECT t.id, t.title, t.created_by, t.created_note, t.initiative_id, left(t.due_date, 10) AS due,
      coalesce((SELECT array_agg(a.member_id) FROM pm.task_assignees a WHERE a.task_id = t.id), '{}') AS assignees FROM pm.tasks t WHERE t.id = ANY($1::uuid[])`, [made?.run?.task_ids ?? []]);
    const byTitle = new Map(madeTasks.map((t) => [t.title, t]));
    check('approve (session): the run is made as the approver, from the draft (retro left out, press kit added)', approved.status === 200 && approved.body.data.draft.status === 'approved'
      && approved.body.data.draft.run_id === made?.run?.id && madeTasks.length === 6 && madeTasks.every((t) => t.created_by === s.morgan)
      && !byTitle.has('Retro on Nova') && byTitle.get('Press kit for Nova')?.due === '2027-05-29', { status: approved.status, body: approved.body?.error ?? approved.body?.data?.draft, titles: madeTasks.map((t) => t.title) });
    check('approve: "runner" is the approver; a template default member stands', JSON.stringify(byTitle.get('Assets for Nova')?.assignees) === JSON.stringify([s.morgan])
      && JSON.stringify(byTitle.get('Copy for Nova')?.assignees) === JSON.stringify([s.nina]), madeTasks.map((t) => [t.title, t.assignees]));
    const madeRun = (await s.q<Loose>('SELECT run_by, via, snapshot, initiative_id FROM pm.task_template_runs WHERE id = $1', [made?.run?.id]))[0];
    // (A task made in the app carries no created_note by design; over the API it reads "..., drafted by Atlas".)
    check('approve: the run says who drafted it (run_by the approver, draft_id, drafted_by, note)', madeRun?.run_by === s.morgan && madeRun.via === 'app'
      && madeRun.snapshot.draft?.drafted_by === s.atlas && made.run.note === 'Drafted by Atlas' && made.run.draft_id === draft.id && made.run.drafted_by === s.atlas, { run: made?.run });
    const entry = await s.q<Loose>('SELECT kind, title, created_by FROM pm.initiative_entries WHERE initiative_id = $1', [madeRun?.initiative_id]);
    check('approve: the initiative carries a "Drafted by" note', entry.some((e) => e.kind === 'note' && e.title === 'Drafted by Atlas' && e.created_by === s.morgan)
      && madeTasks.every((t) => t.initiative_id === madeRun.initiative_id), entry);
    const decidedApproval = (await s.q<Loose>('SELECT status, answer_choice, answered_by, decided_via FROM pm.questions WHERE id = $1', [draft.question_id]))[0];
    check('approve: the linked approval is answered approve, by the approver, in the app', decidedApproval.status === 'answered' && decidedApproval.answer_choice === 'approve'
      && decidedApproval.answered_by === s.morgan && decidedApproval.decided_via === 'app', decidedApproval);
    const twice = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft.id}/approve`, { draftId: draft.id }, {});
    check('approve: a second approve is 409, nothing more made', twice.status === 409 && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE snapshot -> \'draft\' ->> \'id\' = $1', [draft.id]) === 1, twice.body);

    // An added step assigned to someone else: Morgan may not assign others.
    const assigned = await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, {
      ...draftInput, idempotency_key: 'nova-draft-2', values: { product: 'Vega' }, extra_steps: [{ title: 'Partner email', assignee: s.nina, due_in_days: 1 }],
    });
    const draft2 = assigned.body?.data;
    const tasksBefore2 = await tasks();
    const morganRefused = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft2?.id}/approve`, { draftId: draft2?.id }, {});
    check('approve: an added step\'s assignee is checked against the approver\'s own rights (403 cannot_assign_others at its path), nothing made',
      assigned.status === 201 && morganRefused.status === 403 && reason(morganRefused) === 'cannot_assign_others'
      && morganRefused.body.error.details.errors.some((e: Loose) => e.path === 'extra_steps[0].assignee') && await tasks() === tasksBefore2
      && (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft2?.id]))[0].status === 'pending'
      && (await s.q<Loose>('SELECT status FROM pm.questions WHERE id = $1', [draft2?.question_id]))[0].status === 'open', morganRefused.body);
    // The template changes before anyone approves: the draft says so and still makes what it saw.
    const versionBefore = (await s.q<Loose>('SELECT version FROM pm.task_templates WHERE id = $1', [T]))[0].version;
    await s.q("UPDATE pm.task_templates SET items = items || '[{\"key\":\"late\",\"title\":\"Late addition\"}]'::jsonb WHERE id = $1", [T]);
    as(LOGINS.owner);
    const changed = await session(draftOne.GET, 'GET', `/api/workspace/task-templates/drafts/${draft2?.id}`, { draftId: draft2?.id });
    check('drafts: a template changed since is reported (template_changed, preview.template_changed_since)', changed.status === 200 && changed.body.data.template_changed === true
      && changed.body.data.preview?.template_changed_since?.from_version === versionBefore && changed.body.data.preview.template_changed_since.to_version === versionBefore + 1
      && !changed.body.data.preview.tasks.some((t: Loose) => t.key === 'late'), changed.body?.data);
    // Olivia (the Owner, who may assign others) approves through the approval card.
    const card = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft2?.question_id}/answer`, { id: draft2?.question_id }, { choice: 'approve' });
    const draft2Row = (await s.q<Loose>('SELECT status, run_id, decided_by FROM pm.task_template_run_drafts WHERE id = $1', [draft2?.id]))[0];
    const run2 = (await s.q<Loose>('SELECT run_by, template_version, snapshot FROM pm.task_template_runs WHERE id = $1', [draft2Row?.run_id]))[0];
    check('approval card: Approve on the approval approves the draft, the run made as the person deciding', card.status === 200 && draft2Row.status === 'approved'
      && draft2Row.decided_by === s.owner && run2?.run_by === s.owner, { card: card.body, draft2Row });
    check('approval card: the draft made what it saw (its template version, without the later step)', run2?.template_version === versionBefore
      && !run2.snapshot.items.some((i: Loose) => i.key === 'late') && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Partner email'") === 1, run2);

    // An agent named in the approval cannot approve; nor a personal agent for its person.
    // (Atlas may name Rex as its approver only while Rex is its orchestrator: security review finding 4.)
    await s.q('UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [s.rex, s.atlas]);
    const draft3 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, {
      ...draftInput, idempotency_key: 'nova-draft-3', values: { product: 'Lyra' }, asked_to: s.rex,
    })).body?.data;
    await s.q('UPDATE pm.team_members SET orchestrator_id = NULL WHERE id = $1', [s.atlas]);
    const rexApproves = await v1(v1Approve.POST, 'POST', `/api/v1/task-templates/drafts/${draft3?.id}/approve`, { draftId: draft3?.id }, s.keys.rex, {});
    check('approve: an agent never approves a draft, even one its approval names (403 draft_needs_person)', draft3?.status === 'pending' && rexApproves.status === 403
      && reason(rexApproves) === 'draft_needs_person' && (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft3?.id]))[0].status === 'pending', rexApproves.body);
    const piaApproves = await v1(v1Approve.POST, 'POST', `/api/v1/task-templates/drafts/${draft3?.id}/approve`, { draftId: draft3?.id }, s.keys.pia, {});
    check('approve: a personal agent acting for its person (the Owner) cannot approve either (403 draft_needs_person)', piaApproves.status === 403
      && reason(piaApproves) === 'draft_needs_person' && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Lyra%'") === 0, piaApproves.body);
    // Olivia rejects it with her own key.
    const rejected = await v1(v1Reject.POST, 'POST', `/api/v1/task-templates/drafts/${draft3?.id}/reject`, { draftId: draft3?.id }, s.keys.owner, { note: 'Not this quarter.' });
    const q3 = (await s.q<Loose>('SELECT status, answer_choice, answer_text, decided_via FROM pm.questions WHERE id = $1', [draft3?.question_id]))[0];
    check('reject: a person\'s own key rejects; the approval is answered reject; nothing made', rejected.status === 200 && rejected.body.data.draft.status === 'rejected'
      && rejected.body.data.run === null && q3.answer_choice === 'reject' && q3.answer_text === 'Not this quarter.' && q3.decided_via === 'api_key'
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Lyra%'") === 0, { rejected: rejected.body, q3 });
    const rejectedAgain = await v1(v1Approve.POST, 'POST', `/api/v1/task-templates/drafts/${draft3?.id}/approve`, { draftId: draft3?.id }, s.keys.owner, {});
    check('reject: a rejected draft cannot be approved later (409 draft_decided)', rejectedAgain.status === 409 && reason(rejectedAgain) === 'draft_decided', rejectedAgain.body);

    // Reject on the approval card rejects the draft.
    const draft4 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-4', values: { product: 'Orion' } })).body?.data;
    as(LOGINS.morgan);
    const cardReject = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft4?.question_id}/answer`, { id: draft4?.question_id }, { choice: 'reject' });
    check('approval card: Reject on the approval rejects the draft', cardReject.status === 200
      && (await s.q<Loose>('SELECT status, decided_by FROM pm.task_template_run_drafts WHERE id = $1', [draft4?.id]))[0]?.status === 'rejected', cardReject.body);

    // Expiry: the watchdog expires the approval, and the draft with it; a withdrawn approval too.
    const draft5 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-5', values: { product: 'Pyxis' } })).body?.data;
    const draft6 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-6', values: { product: 'Rigel' } })).body?.data;
    await s.q("UPDATE pm.questions SET expires_at = now() - interval '1 minute' WHERE id = $1", [draft5?.question_id]);
    await s.q('SELECT pm.run_watchdog()');
    await s.q("UPDATE pm.questions SET status = 'cancelled', cancelled_by = asked_by, cancelled_at = now() WHERE id = $1", [draft6?.question_id]);
    const expired = await v1(v1DraftOne.GET, 'GET', `/api/v1/task-templates/drafts/${draft5?.id}`, { draftId: draft5?.id }, s.keys.atlas);
    const withdrawn = (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft6?.id]))[0];
    check('expiry: a draft expires when the watchdog expires its approval (no preview once decided)', expired.status === 200 && expired.body.data.status === 'expired'
      && expired.body.data.preview === null, expired.body?.data);
    check('expiry: a withdrawn approval expires its draft', withdrawn?.status === 'expired', withdrawn);
    as(LOGINS.morgan);
    const lateApprove = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft5?.id}/approve`, { draftId: draft5?.id }, {});
    check('expiry: an expired draft cannot be approved (409), nothing made', lateApprove.status === 409 && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Pyxis%'") === 0, lateApprove.body);

    // A person's own key with approvals.decide approves over the API; the tasks note the draft.
    const draft7 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-7', values: { product: 'Sirius' } })).body?.data;
    const keyApprove = await v1(v1Approve.POST, 'POST', `/api/v1/task-templates/drafts/${draft7?.id}/approve`, { draftId: draft7?.id }, s.keys.owner, {});
    const keyTasks = await s.q<Loose>('SELECT created_by, created_note FROM pm.tasks WHERE id = ANY($1::uuid[])', [keyApprove.body?.data?.run?.run?.task_ids ?? []]);
    check('approve (own key): approves over the API, tasks made as the person, noted "drafted by Atlas"', keyApprove.status === 200 && keyApprove.body.data.draft.status === 'approved'
      && keyTasks.length === 7 && keyTasks.every((t) => t.created_by === s.owner && /drafted by Atlas/.test(t.created_note ?? ''))
      && keyApprove.body.data.run.run.via === 'api', { status: keyApprove.status, body: keyApprove.body?.error, keyTasks });

    // Lists by project and status.
    as(LOGINS.owner);
    const listed = await session(draftList.GET, 'GET', `/api/workspace/task-templates/drafts?project_id=${s.launches}&status=approved`);
    check('drafts: listed by project and status', listed.status === 200 && listed.body.data.drafts.length === 3 && listed.body.data.drafts.every((x: Loose) => x.status === 'approved'), listed.body?.data);
    // A person may draft too, from the app.
    const personDraft = await session(draftRoute.POST, 'POST', `/api/workspace/task-templates/${T}/drafts`, { id: T }, { project_id: s.launches, key_dates: draftInput.key_dates, roles: { designer: s.nina }, values: { product: 'Self' }, asked_to: s.morgan });
    check('drafts: a person drafts from the app, asked_to someone else', personDraft.status === 201 && personDraft.body.data.status === 'pending'
      && (await s.q<Loose>('SELECT asked_to FROM pm.questions WHERE id = $1', [personDraft.body.data.question_id]))[0]?.asked_to === s.morgan, personDraft.body);
    // A template an agent wrote: the approval goes to a person who manages the project instead.
    const agentTemplate = (await s.q<{ id: string }>(`INSERT INTO pm.task_templates (name, created_by, items) VALUES ('Agent playbook', $1, '[{"title":"Check in"}]') RETURNING id`, [s.atlas]))[0].id;
    const fallback = await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${agentTemplate}/drafts`, { id: agentTemplate }, s.keys.atlas, { project_id: s.launches, start_date: '2027-01-04' });
    check('drafts: without an eligible template owner, the approval goes to a person who manages the project', fallback.status === 201
      && (await s.q<Loose>('SELECT asked_to FROM pm.questions WHERE id = $1', [fallback.body.data.question_id]))[0]?.asked_to === s.morgan, fallback.body);

    // The run is recorded but reading it back fails: the draft made it, so it stays approved with that run (never pending, never twice).
    const draft8 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-8', values: { product: 'Vela' } })).body?.data;
    as(LOGINS.morgan);
    failNextRunRead = true;
    const readBackFails = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft8?.id}/approve`, { draftId: draft8?.id }, {});
    failNextRunRead = false;
    const draft8Row = (await s.q<Loose>('SELECT status, run_id FROM pm.task_template_run_drafts WHERE id = $1', [draft8?.id]))[0];
    const draft8Runs = await s.q<Loose>("SELECT id FROM pm.task_template_runs WHERE snapshot -> 'draft' ->> 'id' = $1", [draft8?.id]);
    check('approve: a run recorded before its read back failed keeps the draft approved, linked to that run, the approval answered', draft8Runs.length === 1
      && draft8Row?.status === 'approved' && draft8Row.run_id === draft8Runs[0].id && readBackFails.status === 200 && readBackFails.body?.data?.run?.run?.id === draft8Runs[0].id
      && (await s.q<Loose>('SELECT answer_choice FROM pm.questions WHERE id = $1', [draft8?.question_id]))[0]?.answer_choice === 'approve',
      { status: readBackFails.status, body: readBackFails.body?.error ?? readBackFails.body?.data?.draft, draft8Row, runs: draft8Runs.length });
    const retried = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft8?.id}/approve`, { draftId: draft8?.id }, {});
    check('approve: approving it again is 409 and makes nothing twice', retried.status === 409
      && await count("SELECT count(*)::int AS n FROM pm.task_template_runs WHERE snapshot -> 'draft' ->> 'id' = $1", [draft8?.id]) === 1
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Ship Vela'") === 1, retried.body);

    // The template goes to Trash before the approver decides: a clear 404 template_not_found, not "only the person named".
    const draft9 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-9', values: { product: 'Cetus' } })).body?.data;
    await s.q('UPDATE pm.task_templates SET deleted_at = now() WHERE id = $1', [T]);
    const gone = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft9?.id}/approve`, { draftId: draft9?.id }, {});
    await s.q('UPDATE pm.task_templates SET deleted_at = NULL WHERE id = $1', [T]);
    check('approve: a template in Trash is 404 template_not_found; the draft waits, its approval stays open', gone.status === 404 && reason(gone) === 'template_not_found'
      && gone.body.error.details.template_id === T
      && (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft9?.id]))[0]?.status === 'pending'
      && (await s.q<Loose>('SELECT status FROM pm.questions WHERE id = $1', [draft9?.question_id]))[0]?.status === 'open', gone.body);
    as(LOGINS.nina);
    const hiddenApproval = await session(approveRoute.POST, 'POST', `/api/workspace/task-templates/drafts/${draft9?.id}/approve`, { draftId: draft9?.id }, {});
    check('approve: someone the approval does not name still reads 403 not_asked', hiddenApproval.status === 403 && reason(hiddenApproval) === 'not_asked', hiddenApproval.body);

    // The decision comes first: the approval is withdrawn while the approver's run is being checked
    // (the template read). The decision write finds it no longer open, so nothing is claimed or made.
    const draft10 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-10', values: { product: 'Hydra' } })).body?.data;
    as(LOGINS.morgan);
    beforeRequest = {
      match: (request, url) => request.method === 'GET' && url.pathname.endsWith('/task_templates'),
      // A withdrawal as the cancel path makes it: only an open question is cancelled.
      run: () => s.q("UPDATE pm.questions SET status = 'cancelled', cancelled_by = asked_by, cancelled_at = now() WHERE id = $1 AND status = 'open'", [draft10?.question_id]),
    };
    const raced = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft10?.question_id}/answer`, { id: draft10?.question_id }, { choice: 'approve' });
    const raceArmed = beforeRequest !== null;
    beforeRequest = null;
    const draft10Row = (await s.q<Loose>('SELECT status, run_id FROM pm.task_template_run_drafts WHERE id = $1', [draft10?.id]))[0];
    check('decision order: an approval withdrawn while the run is checked is 409, no tasks made, the draft expired with it',
      !raceArmed && raced.status === 409
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Hydra%'") === 0
      && await count("SELECT count(*)::int AS n FROM pm.task_template_runs WHERE snapshot -> 'draft' ->> 'id' = $1", [draft10?.id]) === 0
      && draft10Row?.status === 'expired' && draft10Row.run_id === null
      && (await s.q<Loose>('SELECT status FROM pm.questions WHERE id = $1', [draft10?.question_id]))[0]?.status === 'cancelled',
      { status: raced.status, body: raced.body, raceArmed, draft10Row });

    // A withdrawal that arrives while the tasks are being made (after the draft is claimed) finds the
    // approval already decided: it never leaves tasks beside a cancelled approval.
    const draft12 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-12', values: { product: 'Draco' } })).body?.data;
    beforeRequest = {
      match: (request, url) => request.method === 'POST' && url.pathname.endsWith('/rpc/record_task_template_run'),
      run: () => s.q("UPDATE pm.questions SET status = 'cancelled', cancelled_by = asked_by, cancelled_at = now() WHERE id = $1 AND status = 'open'", [draft12?.question_id]),
    };
    const lateCancel = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft12?.question_id}/answer`, { id: draft12?.question_id }, { choice: 'approve' });
    const lateArmed = beforeRequest !== null;
    beforeRequest = null;
    const q12 = (await s.q<Loose>('SELECT status, answer_choice FROM pm.questions WHERE id = $1', [draft12?.question_id]))[0];
    const draft12Tasks = await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Draco%' AND deleted_at IS NULL");
    check('decision order: a withdrawal while the tasks are made finds the approval decided; the tasks stand beside an approved approval, never a cancelled one',
      !lateArmed && lateCancel.status === 200 && q12?.status === 'answered' && q12.answer_choice === 'approve' && draft12Tasks > 0
      && (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft12?.id]))[0]?.status === 'approved',
      { status: lateCancel.status, body: lateCancel.body?.error ?? null, lateArmed, q12, draft12Tasks });

    // The run fails before it is recorded: the decision is undone, the draft waits and its approval is open again.
    const draft11 = (await v1(v1Draft.POST, 'POST', `/api/v1/task-templates/${T}/drafts`, { id: T }, s.keys.atlas, { ...draftInput, idempotency_key: 'nova-draft-11', values: { product: 'Lynx' } })).body?.data;
    failNextRunRecord = true;
    const runFails = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft11?.question_id}/answer`, { id: draft11?.question_id }, { choice: 'approve' });
    const recordArmed = failNextRunRecord;
    failNextRunRecord = false;
    const q11 = (await s.q<Loose>('SELECT status, answer_choice, answered_by, decided_via FROM pm.questions WHERE id = $1', [draft11?.question_id]))[0];
    check('decision order: a run that fails before it is recorded reopens the approval (no answer kept) and leaves the draft pending, nothing made (a partly made run goes to Trash)',
      !recordArmed && runFails.status >= 400 && q11?.status === 'open' && q11.answer_choice === null && q11.answered_by === null && q11.decided_via === null
      && (await s.q<Loose>('SELECT status FROM pm.task_template_run_drafts WHERE id = $1', [draft11?.id]))[0]?.status === 'pending'
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Lynx%' AND deleted_at IS NULL") === 0,
      { status: runFails.status, body: runFails.body, recordArmed, q11 });
    const retry11 = await session(answerRoute.POST, 'POST', `/api/workspace/questions/${draft11?.question_id}/answer`, { id: draft11?.question_id }, { choice: 'approve' });
    check('decision order: approving it again then works once', retry11.status === 200
      && await count("SELECT count(*)::int AS n FROM pm.task_template_runs WHERE snapshot -> 'draft' ->> 'id' = $1", [draft11?.id]) === 1, retry11.body);
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`template drafts and reflow: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(error);
  process.exit(1);
});
