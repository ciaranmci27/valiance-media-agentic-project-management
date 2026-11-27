/**
 * Initiatives (20261126000100_initiatives.sql), over the real schema, routes
 * and services (session routes with a signed-in member, v1 routes with keys,
 * MCP tools through routeCaller, a fake PostgREST over PGlite):
 * - The migration, run twice on the schema before it, matches schema.sql,
 *   whose last section is the migration word for word.
 * - The database's rules: a task's initiative is in its project and live; a
 *   subtask has its parent's (those in Trash follow too); a move to another
 *   project clears it; an initiative's project never changes; health is an
 *   active initiative's; entries copy their project, issues start open.
 * - Row security: project members read initiatives (guests too); the log
 *   needs tasks.read and is never a guest's; nobody writes from the browser.
 * - Permissions per role: Owner, a member who may create tasks, one who may
 *   not, a tasks.read_assigned member, a guest, keys with and without scopes.
 * - Progress counts top-level tasks the reader can see.
 * - The log: kinds, resolve by anyone who may log, author-only edits.
 * - Trash and restore keep task links; a trashed initiative is refused.
 * - Webhooks; get_initiative bounds; get_task_brief; the search_tasks filter;
 *   initiative briefs as a context scope; the portal never shows them.
 * - New code on a database without the migration degrades, never breaks.
 *
 *   npm run -s test:initiatives
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  createInitiativeSchema, INITIATIVE_LABEL, initiativeProgress, initiativeStateLabel, progressByInitiative, progressLabel, progressPercent,
  sortInitiatives, taskInitiativeId,
} from '../src/lib/initiatives';
import { CONTEXT_SCOPES } from '../src/lib/context-scopes';
import { INITIATIVE_WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES, WORK_WEBHOOK_EVENT_TYPES } from '../src/lib/types';
import { TRASH_TABLES, TRASH_TABLE_MODULE } from '../src/lib/supabase/trash';
import { CORE_TABLES } from '../src/lib/modules/surfaces';
import { profileSeesTool } from '../src/lib/mcp/profiles';

const MIGRATION = '20261126000100_initiatives.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- INITIATIVES (20261126000100_initiatives.sql)\n-- ============================================================\n';
const TOOLS = ['list_initiatives', 'get_initiative', 'create_initiative', 'update_initiative', 'list_initiative_entries', 'add_initiative_entry', 'update_initiative_entry'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOGINS = {
  owner: { id: id(2101), email: 'olivia@studio.example' },
  morgan: { id: id(2102), email: 'morgan@studio.example' },
  nina: { id: id(2103), email: 'nina@studio.example' },
  rita: { id: id(2104), email: 'rita@studio.example' },
  gus: { id: id(2105), email: 'gus@client.example' },
  sam: { id: id(2106), email: 'sam@studio.example' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
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

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  const tasks = [
    { initiative_id: 'a', parent_task_id: null, status: 'done' as const },
    { initiative_id: 'a', parent_task_id: null, status: 'todo' as const },
    { initiative_id: 'a', parent_task_id: 'x', status: 'done' as const },
    { initiative_id: 'b', parent_task_id: null, status: 'done' as const },
    { initiative_id: null, parent_task_id: null, status: 'done' as const },
  ];
  const map = progressByInitiative(tasks);
  check('progress: top-level tasks only, per initiative', map.get('a')?.done === 1 && map.get('a')?.total === 2 && map.get('b')?.total === 1 && map.size === 2, [...map]);
  check('progress: one initiative, percent and words', initiativeProgress(tasks, 'a').total === 2 && progressPercent({ done: 1, total: 3 }) === 33
    && progressPercent({ done: 0, total: 0 }) === 0 && progressLabel({ done: 1, total: 1 }) === '1 of 1 task done' && progressLabel(null) === 'No tasks yet');
  check('labels: one constant names it on screen', INITIATIVE_LABEL.singular === 'Initiative' && INITIATIVE_LABEL.plural === 'Initiatives');
  check('labels: health shows only while active', initiativeStateLabel({ status: 'active', health: 'at_risk' }) === 'Active, at risk'
    && initiativeStateLabel({ status: 'paused', health: 'at_risk' }) === 'Paused');
  check('a task in a trashed initiative reads as in none', taskInitiativeId({ initiative_id: 'gone' }, new Set(['a'])) === null && taskInitiativeId({ initiative_id: 'a' }, new Set(['a'])) === 'a');
  const sorted = sortInitiatives([{ id: '2', sort_order: 1, created_at: '2026-01-01' }, { id: '1', sort_order: 0, created_at: '2026-02-01' }]);
  check('order: sort_order, then age', sorted.map((r) => r.id).join() === '1,2');
  check('schema: one owner at most, dates in order', !createInitiativeSchema.safeParse({ name: 'X', owner_member_id: id(1), owner_group_id: id(2) }).success
    && !createInitiativeSchema.safeParse({ name: 'X', start_date: '2026-05-01', target_date: '2026-04-01' }).success
    && createInitiativeSchema.safeParse({ name: 'X', start_date: '2026-04-01', target_date: '2026-04-01' }).success);
  check('registry: a context scope, Trash tables (core), core tables', CONTEXT_SCOPES.includes('initiative')
    && TRASH_TABLES.includes('initiatives') && TRASH_TABLES.includes('initiative_entries') && TRASH_TABLE_MODULE.initiatives === 'core'
    && CORE_TABLES.includes('initiatives') && CORE_TABLES.includes('initiative_entries'));
  check('webhooks: initiative events exist and are never a new endpoint\'s default', INITIATIVE_WEBHOOK_EVENT_TYPES.every((e) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e))
    && !INITIATIVE_WEBHOOK_EVENT_TYPES.some((e) => (WORK_WEBHOOK_EVENT_TYPES as readonly string[]).includes(e)));
  check('profiles: the generic profile sees every initiative tool', TOOLS.every((name) => profileSeesTool('generic', name)));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  // Later releases add their own sections after this one (TEMPLATES V2 first).
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n', at + BANNER.length);
  const section = next > 0 ? SCHEMA_SQL.slice(at + BANNER.length, next) : SCHEMA_SQL.slice(at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && section.replace(/\n+$/, '') === MIGRATION_SQL.replace(/\n+$/, ''));
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(join(__dirname, '..', 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`) > at), later);
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
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
  const permit = async (memberId: string, key: string, effect: 'allow' | 'deny') => q(
    "INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'app', $3), ($1, $2, 'api', $3) ON CONFLICT DO NOTHING",
    [memberId, key, effect]);
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const nina = await member('Nina', 'member', LOGINS.nina);
  const rita = await member('Rita', 'member', LOGINS.rita);
  const gus = await member('Gus', 'guest', LOGINS.gus);
  const sam = await member('Sam', 'member', LOGINS.sam);
  const agent = await member('Atlas', 'agent');
  await permit(nina, 'tasks.create', 'deny');
  // Rita reads only her own tasks.
  await permit(rita, 'tasks.read', 'deny');
  await permit(rita, 'tasks.read_assigned', 'allow');
  for (const key of ['projects.read', 'tasks.read', 'tasks.create', 'project_context.read', 'project_context.manage']) await permit(agent, key, 'allow');
  await permit(morgan, 'project_context.read', 'allow');
  const project = async (name: string, members: string[]) => {
    const projectId = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [projectId, m]);
    return projectId;
  };
  const launch = await project('Launch', [morgan, nina, rita, gus, agent]);
  const payroll = await project('Payroll', [sam]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['projects.read', 'projects.read_all', 'projects.manage', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all', 'project_context.read', 'project_context.manage']),
    morgan: await key(morgan, ['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_assigned']),
    morganNoCreate: await key(morgan, ['projects.read', 'tasks.read']),
    morganProjectsOnly: await key(morgan, ['projects.read']),
    agent: await key(agent, ['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'project_context.read', 'project_context.manage']),
    agentNoContext: await key(agent, ['projects.read', 'tasks.read', 'tasks.create']),
  };
  return { q, owner, morgan, nina, rita, gus, sam, agent, launch, payroll, keys };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  const q = s.q;
  const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;
  const fails = (sql: string, params: unknown[] = []) => db.exec('RESET ROLE').then(() => db.query(sql, params)).then(() => null, (e: Error & { code?: string }) => e.code ?? e.message);
  const asMember = async <T,>(login: { id: string } | null, work: () => Promise<T>): Promise<T> => {
    await actAs(db, login?.id ?? null);
    try { return await work(); } finally { await actAs(db, null); await db.exec('RESET ROLE'); }
  };

  // Webhook endpoints listening before anything is written.
  await q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Harness', 'https://hooks.example/pm', 'whsec_test',
    ARRAY['initiative.created', 'initiative.updated', 'initiative.deleted', 'initiative_entry.created', 'initiative_entry.updated', 'task.created', 'task.updated'])`);
  const morganHook = (await q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id) VALUES ('Morgan', 'https://hooks.example/morgan', 'whsec_m',
    ARRAY['initiative.updated'], $1) RETURNING id`, [s.morgan]))[0].id;
  const samHook = (await q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id) VALUES ('Sam', 'https://hooks.example/sam', 'whsec_s',
    ARRAY['initiative.updated'], $1) RETURNING id`, [s.sam]))[0].id;

  try {
    const listRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/route');
    const oneRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/[initiativeId]/route');
    const restoreRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/[initiativeId]/restore/route');
    const entriesRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/[initiativeId]/entries/route');
    const entryRoute = await import('../src/app/api/workspace/projects/[id]/initiatives/[initiativeId]/entries/[entryId]/route');
    const v1List = await import('../src/app/api/v1/projects/[id]/initiatives/route');
    const v1One = await import('../src/app/api/v1/projects/[id]/initiatives/[initiativeId]/route');
    const v1Entries = await import('../src/app/api/v1/projects/[id]/initiatives/[initiativeId]/entries/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Task = await import('../src/app/api/v1/tasks/[id]/route');
    const portal = await import('../src/app/api/portal/[token]/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const base = `/api/workspace/projects/${s.launch}/initiatives`;
    const P = (initiativeId?: string, entryId?: string) => ({ id: s.launch, ...(initiativeId ? { initiativeId } : {}), ...(entryId ? { entryId } : {}) });

    check('mcp: the seven initiative tools, gated as their routes', TOOLS.every((name) => PM_TOOLS.some((t) => t.name === name))
      && PM_TOOLS.find((t) => t.name === 'create_initiative')?.permission === 'tasks.create' && PM_TOOLS.find((t) => t.name === 'add_initiative_entry')?.permission === 'tasks.read'
      // Moves to Trash have tools since the API parity decision (2026-11-27), with their routes' gates.
      && JSON.stringify(PM_TOOLS.find((t) => t.name === 'delete_initiative')?.permission) === JSON.stringify(['projects.manage', 'tasks.create'])
      && PM_TOOLS.find((t) => t.name === 'delete_initiative_entry')?.permission === 'tasks.read');

    // ── Create: tasks.create in the project ──────────────────────────
    as(LOGINS.nina);
    const ninaCreate = await session(listRoute.POST, 'POST', base, P(), { name: 'Pricing page' });
    check('permissions: a member without tasks.create cannot create one', ninaCreate.status === 403 && reason(ninaCreate) === 'missing_permission', ninaCreate.body);
    as(LOGINS.gus);
    const gusCreate = await session(listRoute.POST, 'POST', base, P(), { name: 'Pricing page' });
    check('permissions: a guest cannot create one', gusCreate.status === 403, gusCreate.body);
    as(LOGINS.morgan);
    const outOfReach = await session(listRoute.POST, 'POST', `/api/workspace/projects/${s.payroll}/initiatives`, { id: s.payroll }, { name: 'Payroll run' });
    check('permissions: a project the member cannot open reads as missing', outOfReach.status === 404, outOfReach.body);
    const created = await session(listRoute.POST, 'POST', base, P(), {
      name: '  Website relaunch  ', description: 'New site on Next.js', owner_member_id: s.morgan, status: 'active', health: 'at_risk', start_date: '2026-12-01', target_date: '2027-01-15',
    });
    const web = created.body?.data?.id as string;
    check('create: a member with tasks.create makes one, trimmed, owned, ordered first', created.status === 201 && created.body.data.name === 'Website relaunch'
      && created.body.data.owner?.name === 'Morgan' && created.body.data.health === 'at_risk' && created.body.data.sort_order === 0 && created.body.data.created_by === s.morgan, created.body);
    const badHealth = await session(listRoute.POST, 'POST', base, P(), { name: 'Later', status: 'planned', health: 'blocked' });
    check('create: health only while active', badHealth.status === 422 && reason(badHealth) === 'health_needs_active', badHealth.body);
    as(LOGINS.owner);
    const brand = (await session(listRoute.POST, 'POST', base, P(), { name: 'Brand identity', owner_member_id: s.owner })).body?.data?.id as string;
    const print = (await session(listRoute.POST, 'POST', base, P(), { name: 'Print collateral', status: 'done' })).body?.data?.id as string;
    const payrollInit = (await q<{ id: string }>("INSERT INTO pm.initiatives (project_id, name) VALUES ($1, 'Payroll run') RETURNING id", [s.payroll]))[0].id;
    const v1NoScope = await v1(v1List.POST, 'POST', `/api/v1/projects/${s.launch}/initiatives`, P(), s.keys.morganNoCreate, { name: 'Copy deck' });
    check('permissions: a key without the tasks.create scope is refused', v1NoScope.status === 403 && reason(v1NoScope) === 'missing_key_scope', v1NoScope.body);
    const mcpCreate = await runTool(s.keys.agent, s.agent, 'create_initiative', { project_id: s.launch, name: 'Launch emails', status: 'planned' });
    check('mcp: an agent with tasks.create creates one (create_initiative)', mcpCreate.ok === true && mcpCreate.data.name === 'Launch emails' && mcpCreate.data.created_by === s.agent, mcpCreate);
    const emails = mcpCreate.data?.id as string;

    // ── Tasks on its board ───────────────────────────────────────────
    const task = async (title: string, extra: Record<string, unknown> = {}) => {
      const cols = ['project_id', 'title', 'created_by', ...Object.keys(extra)];
      const values = [s.launch, title, s.owner, ...Object.values(extra)];
      return (await q<{ id: string }>(`INSERT INTO pm.tasks (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values))[0].id;
    };
    const tA = await task('Homepage', { initiative_id: web, status: 'done' });
    const tB = await task('Pricing page', { initiative_id: web });
    const tC = await task('Blog', { initiative_id: web });
    const tC1 = await task('Blog list', { parent_task_id: tC, status: 'done' });
    const tLoose = await task('Fix the favicon');
    await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2), ($3, $2)', [tA, s.rita, tC1]);
    check('database: a subtask takes its parent\'s initiative', (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [tC1]))[0].initiative_id === web);

    // ── Progress: top-level tasks the reader can see ─────────────────
    as(LOGINS.owner);
    const ownerList = await session(listRoute.GET, 'GET', base, P());
    const ownerWeb = (ownerList.body?.data?.initiatives ?? []).find((i: Loose) => i.id === web);
    check('progress: every top-level task for whoever reads every task (subtasks left out)', ownerWeb?.progress?.done === 1 && ownerWeb?.progress?.total === 3, ownerWeb?.progress);
    check('list: done ones hidden unless asked, in order', !(ownerList.body?.data?.initiatives ?? []).some((i: Loose) => i.id === print)
      && (ownerList.body?.data?.initiatives ?? []).map((i: Loose) => i.id).slice(0, 2).join() === `${web},${brand}`, ownerList.body?.data?.initiatives?.map((i: Loose) => i.name));
    const withDone = await session(listRoute.GET, 'GET', `${base}?include_done=true`, P());
    check('list: include_done shows done ones', (withDone.body?.data?.initiatives ?? []).some((i: Loose) => i.id === print));
    as(LOGINS.rita);
    const ritaWeb = ((await session(listRoute.GET, 'GET', base, P())).body?.data?.initiatives ?? []).find((i: Loose) => i.id === web);
    check('progress: a tasks.read_assigned member counts only the tasks they can see (theirs, and a parent of theirs)', ritaWeb?.progress?.done === 1 && ritaWeb?.progress?.total === 2, ritaWeb?.progress);
    check('log counts: a member who may not read the log gets none', ritaWeb?.open_issue_count === null, ritaWeb);
    as(LOGINS.gus);
    const gusList = await session(listRoute.GET, 'GET', base, P());
    check('guests: read initiatives and progress', gusList.status === 200 && (gusList.body?.data?.initiatives ?? []).some((i: Loose) => i.id === web && i.progress?.total === 3), gusList.body);
    const projectsOnly = await v1(v1List.GET, 'GET', `/api/v1/projects/${s.launch}/initiatives`, P(), s.keys.morganProjectsOnly);
    check('progress: a key that reads no tasks gets null progress', projectsOnly.status === 200 && projectsOnly.body.data.every((i: Loose) => i.progress === null), projectsOnly.body);

    // ── Updates ──────────────────────────────────────────────────────
    as(LOGINS.morgan);
    const updated = await session(oneRoute.PATCH, 'PATCH', `${base}/${web}`, P(web), { status: 'paused' });
    check('update: health is cleared when it stops being active', updated.status === 200 && updated.body.data.status === 'paused' && updated.body.data.health === null, updated.body);
    const swapOwner = await session(oneRoute.PATCH, 'PATCH', `${base}/${brand}`, P(brand), { owner_group_id: null, owner_member_id: s.morgan });
    check('update: a member owner set', swapOwner.status === 200 && swapOwner.body.data.owner?.id === s.morgan, swapOwner.body);
    as(LOGINS.nina);
    const ninaPatch = await session(oneRoute.PATCH, 'PATCH', `${base}/${web}`, P(web), { name: 'Hijack' });
    check('permissions: a member without tasks.create cannot change one', ninaPatch.status === 403, ninaPatch.body);
    const mcpUpdate = await runTool(s.keys.agent, s.agent, 'update_initiative', { project_id: s.launch, initiative_id: web, status: 'active', health: 'on_track' });
    check('mcp: update_initiative', mcpUpdate.ok === true && mcpUpdate.data.health === 'on_track', mcpUpdate);

    // ── The database's rules ─────────────────────────────────────────
    check('database: a task\'s initiative in another project is refused', (await fails('UPDATE pm.tasks SET initiative_id = $1 WHERE id = $2', [payrollInit, tLoose])) === '23514');
    await q('UPDATE pm.initiatives SET project_id = $1 WHERE id = $2', [s.payroll, brand]);
    check('database: an initiative\'s project never changes', (await q('SELECT project_id FROM pm.initiatives WHERE id = $1', [brand]))[0].project_id === s.launch);
    check('database: one owner at most', (await fails('UPDATE pm.initiatives SET owner_member_id = $1, owner_group_id = gen_random_uuid() WHERE id = $2', [s.owner, brand])) !== null);
    check('database: an initiative is never permanently deleted', (await fails('DELETE FROM pm.initiatives WHERE id = $1', [brand])) !== null);
    await q('UPDATE pm.tasks SET initiative_id = $1 WHERE id = $2', [brand, tC1]);
    check('database: a subtask cannot differ from its parent', (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [tC1]))[0].initiative_id === web);
    // A trashed subtask follows its parent's initiative too.
    await q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [tC1]);
    await q('UPDATE pm.tasks SET initiative_id = $1 WHERE id = $2', [emails, tC]);
    check('database: a parent\'s change cascades to its subtasks, those in Trash included', (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [tC1]))[0].initiative_id === emails);
    await q('UPDATE pm.tasks SET initiative_id = $1 WHERE id = $2', [web, tC]);
    await q('UPDATE pm.tasks SET deleted_at = NULL WHERE id = $1', [tC1]);
    // A move to another project clears it, for the subtasks too.
    const mover = await task('Moving', { initiative_id: web });
    const moverChild = await task('Moving child', { parent_task_id: mover });
    await q('UPDATE pm.tasks SET project_id = $1 WHERE id = $2', [s.payroll, mover]);
    const moved = await q('SELECT id, initiative_id, project_id FROM pm.tasks WHERE id = ANY($1::uuid[])', [[mover, moverChild]]);
    check('database: moving a task to another project clears its initiative and its subtasks\'', moved.length === 2 && moved.every((r: Loose) => r.initiative_id === null && r.project_id === s.payroll), moved);
    await q('UPDATE pm.tasks SET project_id = $1, initiative_id = $2 WHERE id = $3', [s.launch, web, mover]);
    check('database: a move that names an initiative there keeps it', (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [mover]))[0].initiative_id === web
      && (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [moverChild]))[0].initiative_id === web);
    await q('UPDATE pm.tasks SET deleted_at = now() WHERE id = ANY($1::uuid[])', [[mover, moverChild]]);
    const progressView = (await q('SELECT done, total FROM pm.initiative_progress WHERE initiative_id = $1', [web]))[0];
    check('database: the progress view counts live top-level tasks only', progressView?.total === 3 && progressView?.done === 1, progressView);

    // ── Tasks over the API ───────────────────────────────────────────
    const v1Create = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.morgan, { project_id: s.launch, title: 'Sitemap', initiative_id: web });
    check('tasks: create_task takes initiative_id', v1Create.status === 201 && v1Create.body.data.initiative_id === web, v1Create.body);
    const crossCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, { project_id: s.launch, title: 'Wrong one', initiative_id: payrollInit });
    check('tasks: an initiative in another project is refused, saying why', crossCreate.status === 400 && reason(crossCreate) === 'initiative_not_in_project', crossCreate.body);
    const subCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, { parent_task_id: tB, title: 'Sub', initiative_id: brand });
    check('tasks: a subtask naming another initiative than its parent\'s is refused', subCreate.status === 400 && reason(subCreate) === 'subtask_initiative', subCreate.body);
    const subOk = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, { parent_task_id: tB, title: 'Pricing table' });
    check('tasks: a subtask lands in its parent\'s initiative', subOk.status === 201 && (await q('SELECT initiative_id FROM pm.tasks WHERE id = $1', [subOk.body?.data?.id]))[0]?.initiative_id === web, subOk.body);
    const patchCross = await v1(v1Task.PATCH, 'PATCH', `/api/v1/tasks/${tLoose}`, { id: tLoose }, s.keys.owner, { initiative_id: payrollInit });
    check('tasks: update_task refuses an initiative in another project', patchCross.status === 400 && reason(patchCross) === 'initiative_not_in_project', patchCross.body);
    const patchOk = await runTool(s.keys.owner, s.owner, 'update_task', { task_id: tLoose, initiative_id: brand });
    check('tasks: update_task sets it (MCP)', patchOk.ok === true && patchOk.data.initiative_id === brand, patchOk);
    const tagged = await runTool(s.keys.agent, s.agent, 'search_tasks', { initiative_id: web });
    const taggedIds = ((tagged.data ?? []) as Loose[]).map((t) => t.id);
    check('search_tasks: the initiative filter, subtasks included', tagged.ok === true && [tA, tB, tC, tC1].every((x) => taggedIds.includes(x)) && !taggedIds.includes(tLoose), taggedIds);
    const looseOne = await task('Update the footer');
    const untagged = await v1(v1Tasks.GET, 'GET', `/api/v1/tasks?project_id=${s.launch}&initiative_id=none`, {}, s.keys.owner);
    check('GET /tasks: initiative_id=none lists tasks in no initiative', untagged.status === 200 && untagged.body.data.every((t: Loose) => t.initiative_id === null) && untagged.body.data.some((t: Loose) => t.id === looseOne), untagged.body?.data?.length);
    const createdEvent = (await q("SELECT payload FROM pm.webhook_events WHERE event_type = 'task.created' AND resource_id = $1", [v1Create.body?.data?.id]))[0];
    check('webhooks: task.* payloads carry initiative_id', createdEvent?.payload?.data?.task?.initiative_id === web, createdEvent?.payload?.data?.task);

    // ── The log ──────────────────────────────────────────────────────
    as(LOGINS.morgan);
    const issue = await session(entriesRoute.POST, 'POST', `${base}/${web}/entries`, P(web), { kind: 'issue', title: 'CMS choice open', body: 'Waiting on IT', task_id: tB });
    const issueId = issue.body?.data?.id as string;
    check('log: an issue starts open, its project copied, its author named', issue.status === 201 && issue.body.data.status === 'open' && issue.body.data.project_id === s.launch
      && issue.body.data.created_by_name === 'Morgan', issue.body);
    const decision = await session(entriesRoute.POST, 'POST', `${base}/${web}/entries`, P(web), { kind: 'decision', title: 'Next.js it is' });
    check('log: a decision has no status', decision.status === 201 && decision.body.data.status === null, decision.body);
    const badTask = await session(entriesRoute.POST, 'POST', `${base}/${web}/entries`, P(web), { kind: 'note', title: 'Elsewhere', task_id: payrollInit });
    check('log: a task outside the project is refused', badTask.status === 422, badTask.body);
    as(LOGINS.owner);
    const notAuthor = await session(entryRoute.PATCH, 'PATCH', `${base}/${web}/entries/${issueId}`, P(web, issueId), { title: 'Mine now' });
    check('log: only its author edits an entry', notAuthor.status === 403 && reason(notAuthor) === 'not_author', notAuthor.body);
    const resolved = await session(entryRoute.PATCH, 'PATCH', `${base}/${web}/entries/${issueId}`, P(web, issueId), { status: 'resolved' });
    check('log: anyone who may log resolves an issue, stamped', resolved.status === 200 && resolved.body.data.status === 'resolved' && resolved.body.data.resolved_by === s.owner
      && !!resolved.body.data.resolved_at, resolved.body);
    const notIssue = await session(entryRoute.PATCH, 'PATCH', `${base}/${web}/entries/${decision.body?.data?.id}`, P(web, decision.body?.data?.id), { status: 'resolved' });
    check('log: only an issue has a status', notIssue.status === 422 && reason(notIssue) === 'not_an_issue', notIssue.body);
    as(LOGINS.morgan);
    const authorEdit = await session(entryRoute.PATCH, 'PATCH', `${base}/${web}/entries/${issueId}`, P(web, issueId), { body: 'IT said yes' });
    check('log: its author edits it', authorEdit.status === 200 && authorEdit.body.data.body === 'IT said yes' && authorEdit.body.data.status === 'resolved', authorEdit.body);
    as(LOGINS.gus);
    const gusEntries = await session(entriesRoute.GET, 'GET', `${base}/${web}/entries`, P(web));
    const gusAdd = await session(entriesRoute.POST, 'POST', `${base}/${web}/entries`, P(web), { kind: 'note', title: 'Hello' });
    check('log: guests neither read nor write it', gusEntries.status === 403 && gusAdd.status === 403 && reason(gusEntries) === 'guest', gusEntries.body);
    const gusDetail = await session(oneRoute.GET, 'GET', `${base}/${web}`, P(web));
    check('log: a guest\'s page read leaves it out', gusDetail.status === 200 && gusDetail.body.data.open_issues === null && gusDetail.body.data.recent_entries === null && gusDetail.body.data.can.log === false, gusDetail.body?.data?.can);
    const mcpAdd = await runTool(s.keys.agent, s.agent, 'add_initiative_entry', { project_id: s.launch, initiative_id: web, kind: 'update', title: 'Crawled the old site' });
    const mcpList = await runTool(s.keys.agent, s.agent, 'list_initiative_entries', { project_id: s.launch, initiative_id: web, kind: 'issue' });
    check('mcp: add_initiative_entry and list_initiative_entries (filtered)', mcpAdd.ok === true && mcpAdd.data.kind === 'update'
      && mcpList.ok === true && mcpList.data.every((e: Loose) => e.kind === 'issue') && mcpList.data.length === 1, { mcpAdd, mcpList });
    const mcpResolve = await runTool(s.keys.agent, s.agent, 'update_initiative_entry', { project_id: s.launch, initiative_id: web, entry_id: issueId, status: 'open' });
    check('mcp: update_initiative_entry reopens an issue', mcpResolve.ok === true && mcpResolve.data.status === 'open' && mcpResolve.data.resolved_at === null, mcpResolve);
    const noTasksRead = await v1(v1Entries.GET, 'GET', `/api/v1/projects/${s.launch}/initiatives/${web}/entries`, P(web), s.keys.morganProjectsOnly);
    check('log: a key without tasks.read is refused', noTasksRead.status === 403, noTasksRead.body);

    // ── get_initiative bounds ────────────────────────────────────────
    await q(`INSERT INTO pm.initiative_entries (initiative_id, kind, title, created_by)
      SELECT $1, 'issue', 'Issue ' || n, $2 FROM generate_series(1, 24) n`, [web, s.morgan]);
    const totalEntries = await count('SELECT count(*)::int AS n FROM pm.initiative_entries WHERE initiative_id = $1 AND deleted_at IS NULL', [web]);
    const openIssues = await count("SELECT count(*)::int AS n FROM pm.initiative_entries WHERE initiative_id = $1 AND kind = 'issue' AND status = 'open'", [web]);
    await q(`INSERT INTO pm.project_context (scope_type, scope_id, category, section, content, pinned, source)
      VALUES ('initiative', $1, 'business_context', 'overview', 'Every page must load under a second.', true, 'human')`, [web]);
    const got = await runTool(s.keys.agent, s.agent, 'get_initiative', { project_id: s.launch, initiative_id: web });
    check('get_initiative: open issues capped at 20 with more', got.ok === true && got.data.open_issues.rows.length === 20 && got.data.open_issues.more === openIssues - 20, got.data?.open_issues?.more);
    check('get_initiative: the last 10 entries with more, newest first', got.data?.recent_entries?.rows?.length === 10 && got.data.recent_entries.more === totalEntries - 10
      && got.data.recent_entries.rows[0].created_at >= got.data.recent_entries.rows[9].created_at, got.data?.recent_entries?.more);
    check('get_initiative: pinned brief entries and the header with progress', got.data?.brief?.rows?.length === 1 && got.data.brief.rows[0].content.includes('under a second')
      && got.data.initiative.progress.total >= 3 && got.data.initiative.open_issue_count === openIssues, got.data?.brief);
    const gotNoContext = await runTool(s.keys.agentNoContext, s.agent, 'get_initiative', { project_id: s.launch, initiative_id: web });
    check('get_initiative: no brief without project_context.read', gotNoContext.ok === true && gotNoContext.data.brief === null, gotNoContext.data?.brief);

    // ── get_task_brief and the brief as a context scope ──────────────
    const brief = await runTool(s.keys.agent, s.agent, 'get_task_brief', { task_id: tB });
    check('get_task_brief: carries the task\'s initiative and its pinned brief', brief.ok === true && brief.data.initiative?.id === web && brief.data.initiative.name === 'Website relaunch'
      && brief.data.initiative.brief?.rows?.length === 1 && brief.data.task.initiative_id === web, brief.data?.initiative);
    const looseBrief = await runTool(s.keys.agent, s.agent, 'get_task_brief', { task_id: await task('No initiative') });
    check('get_task_brief: null for a task in none', looseBrief.ok === true && looseBrief.data.initiative === null, looseBrief.data?.initiative);
    const addBrief = await runTool(s.keys.agent, s.agent, 'add_context', { scope_type: 'initiative', scope_id: web, content: 'Staging is at staging.example.com', pinned: false });
    const addBriefDenied = await runTool(s.keys.agentNoContext, s.agent, 'add_context', { scope_type: 'initiative', scope_id: web, content: 'Nope' });
    check('brief: written as a context scope with project_context.manage, refused without', addBrief.ok === true && addBrief.data.scope_type === 'initiative' && addBriefDenied.ok === false, { addBrief, addBriefDenied });
    const found = await runTool(s.keys.agent, s.agent, 'search_context', { q: 'staging', scope_types: ['initiative'] });
    check('brief: search_context finds it in the initiatives the caller reaches', found.ok === true && found.data.some((e: Loose) => e.scope_id === web), found);

    // ── Webhooks ─────────────────────────────────────────────────────
    const events = await q<{ event_type: string; resource_id: string; payload: Loose }>("SELECT event_type, resource_id, payload FROM pm.webhook_events WHERE event_type LIKE 'initiative%' ORDER BY sequence");
    const types = new Set(events.map((e) => e.event_type));
    check('webhooks: initiative.created, initiative.updated and the log\'s events', ['initiative.created', 'initiative.updated', 'initiative_entry.created', 'initiative_entry.updated'].every((t) => types.has(t)), [...types]);
    const updatedEvent = events.find((e) => e.event_type === 'initiative.updated' && e.resource_id === web);
    check('webhooks: initiative.updated names its changes and carries the initiative', updatedEvent?.payload?.data?.initiative?.id === web && Array.isArray(updatedEvent?.payload?.data?.changes)
      && updatedEvent.payload.data.member_ids.includes(s.morgan), updatedEvent?.payload?.data);
    const entryEvent = events.find((e) => e.event_type === 'initiative_entry.created' && e.resource_id === issueId);
    check('webhooks: initiative_entry.created carries the entry and its initiative', entryEvent?.payload?.data?.entry?.kind === 'issue' && entryEvent.payload.data.initiative?.name === 'Website relaunch', entryEvent?.payload?.data);
    check('webhooks: a member filter matches the owner, and no one else', await count('SELECT count(*)::int AS n FROM pm.webhook_deliveries WHERE endpoint_id = $1', [morganHook]) > 0
      && await count('SELECT count(*)::int AS n FROM pm.webhook_deliveries WHERE endpoint_id = $1', [samHook]) === 0);

    // ── Trash and restore ────────────────────────────────────────────
    as(LOGINS.nina);
    const ninaTrash = await session(oneRoute.DELETE, 'DELETE', `${base}/${web}`, P(web));
    check('trash: neither its creator nor a project manager is refused', ninaTrash.status === 403, ninaTrash.body);
    as(LOGINS.morgan);
    const trashed = await session(oneRoute.DELETE, 'DELETE', `${base}/${web}`, P(web));
    check('trash: its creator moves it to Trash', trashed.status === 200, trashed.body);
    const afterOne = await session(oneRoute.GET, 'GET', `${base}/${web}`, P(web));
    const afterList = await session(listRoute.GET, 'GET', `${base}?include_done=true`, P());
    const afterLog = await session(entriesRoute.GET, 'GET', `${base}/${web}/entries`, P(web));
    check('trash: it reads as missing, its log with it', afterOne.status === 404 && afterLog.status === 404 && !afterList.body?.data?.initiatives?.some((i: Loose) => i.id === web), afterOne.status);
    check('trash: its tasks keep the link', await count('SELECT count(*)::int AS n FROM pm.tasks WHERE initiative_id = $1 AND deleted_at IS NULL', [web]) >= 4);
    check('trash: a task cannot join an initiative in Trash', (await fails('UPDATE pm.tasks SET initiative_id = $1 WHERE id = $2', [web, tLoose])) === '23514');
    const trashedCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, { project_id: s.launch, title: 'Late', initiative_id: web });
    check('trash: the API refuses a trashed initiative, saying why', trashedCreate.status === 400 && reason(trashedCreate) === 'initiative_not_in_project', trashedCreate.body);
    const morganTrash = await asMember(LOGINS.morgan, async () => (await db.query<Loose>("SELECT record_type, id, label, context FROM pm.list_trash(ARRAY['initiatives'])")).rows);
    check('trash: listed in Settings > Trash for its creator', morganTrash.some((r) => r.id === web && r.label === 'Website relaunch' && r.context === 'Launch'), morganTrash);
    as(LOGINS.morgan);
    const restored = await session(restoreRoute.POST, 'POST', `${base}/${web}/restore`, P(web));
    check('restore: it comes back with its tasks still on its board', restored.status === 200 && restored.body.data.progress?.total >= 3
      && await count('SELECT count(*)::int AS n FROM pm.trash_events WHERE table_name = $1 AND record_id = $2', ['initiatives', web]) === 2, restored.body);
    const activity = await q<{ type: string }>("SELECT type FROM pm.activities WHERE entity_type IN ('initiative', 'initiative_entry') ORDER BY created_at");
    const activityTypes = new Set(activity.map((a) => a.type));
    check('team activity: made, changed, logged, resolved, Trash and back', ['initiative.created', 'initiative.status', 'initiative_entry.added', 'initiative_entry.resolved', 'record.trashed', 'record.restored']
      .every((t) => activityTypes.has(t)), [...activityTypes]);
    // An entry in Trash waits for its initiative.
    as(LOGINS.morgan);
    const decisionId = decision.body?.data?.id as string;
    const trashedEntry = await session(entryRoute.DELETE, 'DELETE', `${base}/${web}/entries/${decisionId}`, P(web, decisionId));
    await q('UPDATE pm.initiatives SET deleted_at = now() WHERE id = $1', [web]);
    const blocked = await asMember(LOGINS.morgan, () => db.query("SELECT pm.restore_record('initiative_entries', $1)", [decisionId]).then(() => 'ok', (e: Error & { code?: string }) => e.code));
    await q('UPDATE pm.initiatives SET deleted_at = NULL WHERE id = $1', [web]);
    const back = await asMember(LOGINS.morgan, () => db.query("SELECT pm.restore_record('initiative_entries', $1)", [decisionId]).then(() => 'ok', (e: Error & { code?: string }) => e.code));
    check('trash: an entry goes to Trash by its author and comes back only after its initiative', trashedEntry.status === 200 && blocked === '55000' && back === 'ok', { trashedEntry: trashedEntry.status, blocked, back });

    // ── Row security ─────────────────────────────────────────────────
    const seen = async (login: { id: string }, table: string) => asMember(login, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm.${table}`)).rows[0].n);
    check('policy: a project member reads its initiatives; an outsider only their own project\'s', await seen(LOGINS.morgan, 'initiatives') >= 3
      && await seen(LOGINS.sam, 'initiatives') === 1 && await seen(LOGINS.sam, 'initiative_entries') === 0);
    check('policy: a guest reads initiatives but not the log', await seen(LOGINS.gus, 'initiatives') >= 3 && await seen(LOGINS.gus, 'initiative_entries') === 0);
    check('policy: a tasks.read_assigned member reads initiatives but not the log', await seen(LOGINS.rita, 'initiatives') >= 3 && await seen(LOGINS.rita, 'initiative_entries') === 0);
    check('policy: a member who may comment reads the log', await seen(LOGINS.morgan, 'initiative_entries') > 10);
    const browserWrite = await asMember(LOGINS.morgan, () => db.query("INSERT INTO pm.initiatives (project_id, name) VALUES ($1, 'From the browser')", [s.launch]).then(() => 'ok', (e: Error) => e.message));
    check('policy: nobody writes initiatives from the browser', /permission denied/.test(browserWrite), browserWrite);
    const guestActivity = await asMember(LOGINS.gus, async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.activities WHERE entity_type = 'initiative_entry'")).rows[0].n);
    const memberActivity = await asMember(LOGINS.morgan, async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.activities WHERE entity_type = 'initiative_entry'")).rows[0].n);
    check('policy: the log\'s team activity is never a guest\'s', guestActivity === 0 && memberActivity > 0, { guestActivity, memberActivity });
    check('database: a log entry is never permanently deleted', (await fails('DELETE FROM pm.initiative_entries WHERE id = $1', [issueId])) !== null);

    // ── The portal never shows them ──────────────────────────────────
    const token = randomUUID().replace(/-/g, '');
    await q('INSERT INTO pm.portal_settings (project_id, token, enabled, show_hours, show_invoices, show_credentials) VALUES ($1, $2, true, true, true, true)', [s.launch, token]);
    const portalAnswer = await portal.GET(new NextRequest(`http://localhost/api/portal/${token}`), { params: Promise.resolve({ token }) });
    const portalText = await portalAnswer.text();
    check('portal: its answer holds no initiative or log entry', portalAnswer.status === 200 && !/initiative|Website relaunch|CMS choice/i.test(portalText), { status: portalAnswer.status, text: portalText.slice(0, 300) });
    const portalSources = readdirSync(join(__dirname, '..', 'src', 'app', 'api', 'portal'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'portal', f), 'utf8'));
    check('portal: no portal route reads initiatives', portalSources.length > 0 && portalSources.every((src) => !/initiative/i.test(src)));
  } finally {
    await server.close();
    await db.close();
  }

  await oldDatabaseChecks();

  console.log(`initiatives: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

// ── New code on a database without the migration ────────────────────────

async function oldDatabaseChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const db = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await db.exec('RESET ROLE');
  const owner = (await db.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Olivia', 'o@old.example', 'owner') RETURNING id")).rows[0].id;
  const project = (await db.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id")).rows[0].id;
  const taskId = (await db.query<{ id: string }>("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Old task', $2) RETURNING id", [project, owner])).rows[0].id;
  const server = await startFakePostgrest(db);
  try {
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { listInitiatives, assertInitiativeInProject } = await import('../src/lib/api/initiatives');
    const { createTaskAs } = await import('../src/lib/api/create-task');
    const { buildTaskBrief } = await import('../src/lib/api/task-brief');
    const { scopeAccess, searchScopedContext } = await import('../src/lib/api/context-scopes');
    const { createTaskSchema } = await import('../src/lib/schemas/tasks');
    const { API_ENDPOINT_PERMISSIONS } = await import('../src/lib/access-control');
    const client = createPmClient(server.url, 'fake-service-key', { auth: { persistSession: false, autoRefreshToken: false } });
    const access = (await resolveMemberAccess(client, owner))!;
    const caller = { memberId: owner, access, scopes: [...API_ENDPOINT_PERMISSIONS] as string[] };
    const pending = (error: unknown) => (error as { statusCode?: number; details?: { reason?: string } })?.statusCode === 503
      && (error as { details?: { reason?: string } }).details?.reason === 'migration_pending';
    check('old database: listing initiatives says the update is pending (503)', await listInitiatives(client, caller, project, { offset: 0, limit: 10 }).then(() => false, pending));
    check('old database: naming an initiative on a task says the update is pending', await assertInitiativeInProject(client, randomUUID(), project).then(() => false, pending));
    const made = await createTaskAs({ supabase: client, memberId: owner, access, canAssignOthers: true }, createTaskSchema.parse({ project_id: project, title: 'Still works' }));
    check('old database: creating a task without an initiative still works', !!made?.id, made);
    const brief = await buildTaskBrief({ supabase: client, access, scopes: caller.scopes, teamMemberId: owner }, taskId);
    check('old database: the task brief still answers, with no initiative', brief?.task?.id === taskId && brief.initiative === null, brief?.initiative);
    check('old database: an initiative scope reads as out of reach', (await scopeAccess(client, caller, { scope_type: 'initiative', scope_id: randomUUID() })).read === false);
    const searched = await searchScopedContext(client, caller, 'anything', { scopeTypes: ['initiative'] }).then((rows) => rows, (error: Error) => error.message);
    check('old database: searching initiative briefs finds nothing, without failing', Array.isArray(searched) && searched.length === 0, searched);
  } finally {
    await server.close();
    await db.close();
  }
}

main().catch((error) => {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(error);
  process.exit(1);
});
