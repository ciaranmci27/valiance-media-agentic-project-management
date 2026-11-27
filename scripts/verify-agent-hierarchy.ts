/**
 * Orchestrators and who can use an agent (20261127001000_agent_hierarchy_access.sql),
 * on PGlite with the full schema and the real routes (v1 with keys, MCP,
 * session routes as a signed-in person, the public chat inbound route), a
 * fake PostgREST in between and every chat provider call mocked:
 * - The migration, run twice on the schema before it, matches schema.sql,
 *   and the previous release's writes still work. New functions are the
 *   server's only; members only read the audience table.
 * - The chart: loops, depth over 4, personal agents and people refused.
 * - Who can use it: include and exclude by role, group and person; an orchestrator's
 *   audience limits every agent under it; personal assistants only for
 *   their person.
 * - Every door refuses a bypass: assigning a task (v1, MCP, the app), chat
 *   and mentions, delegate_task, and starting a child run; skipping a level
 *   is refused; agents with no orchestrator work as before; a three-level chain is
 *   checked for its person at every hop, and losing a middle level's
 *   audience stops it.
 * - Ask first: one approval for the right manager, nothing runs, the same
 *   request goes through once approved; managers never wait.
 * - Moving an agent changes where new work comes from and nothing it has.
 * - The access API and MCP tools, the tree, list and detail fields, the
 *   session routes, template defaults and get_my_status assistants_off.
 *
 *   npm run -s test:agent-hierarchy
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { slackSignature } from '../src/lib/chat/providers/slack';
import { chatHttp } from '../src/lib/chat/providers/adapter';
import { audienceWords } from '../src/lib/api/agent-hierarchy';
import { CORE_AGENT_TEMPLATES } from '../src/lib/agent-templates';

const MIGRATION = '20261127001000_agent_hierarchy_access.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- ORCHESTRATORS AND WHO CAN USE AN AGENT (20261127001000_agent_hierarchy_access.sql)';
const NEW_FUNCTIONS = ['member_may_use_agent', 'agent_audience_members', 'member_manages_agent', 'guard_agent_assignment', 'team_members_orchestrator_guard', 'handle_agent_audience_before_write'];
const APP = 'https://pm.example.com';
const APP_KEY = 'e'.repeat(64);
const SLACK_SECRET = '0f9e8d7c6b5a49382716051f2e3d4c5b';
const SLACK_TOKEN = 'xoxb-3333-4444-companycompany';
const USER_HEADER = 'x-test-user';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string };

const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-00000000f401', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000f402', email: 'ana@example.com' },
  ben: { id: '00000000-0000-4000-8000-00000000f403', email: 'ben@example.com' },
  cara: { id: '00000000-0000-4000-8000-00000000f404', email: 'cara@example.com' },
  dana: { id: '00000000-0000-4000-8000-00000000f405', email: 'dana@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn(db: PGlite) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
      return true;
    };
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' });
    }
    // Hiring makes a login with no password.
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const text = await new Promise<string>((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw));
      });
      const body = JSON.parse(text || '{}');
      const id = randomUUID();
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, String(body.email).toLowerCase()]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email: body.email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' });
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
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-27T00:00:00Z' };
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

const errorOf = (db: PGlite, sql: string, params: unknown[] = []) => db.query(sql, params).then(() => null, (e: Error) => e.message);

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  check('words: no rows reads as today', JSON.stringify(audienceWords([])) === JSON.stringify({ limited: false, words: 'Everyone who can give it work' }));
  check('words: includes name who, excludes say except', audienceWords([
    { kind: 'group', effect: 'include', name: 'Engineering' }, { kind: 'role', effect: 'include', name: 'Admins' }, { kind: 'member', effect: 'exclude', name: 'Ben' },
  ]).words === 'Engineering, Admins, except Ben');
  check('words: an include alone reads "only"; excluding everyone reads no one', audienceWords([{ kind: 'group', effect: 'include', name: 'Engineering' }]).words === 'Engineering only'
    && audienceWords([{ kind: 'everyone', effect: 'exclude', name: 'Everyone' }]).words === 'No one');
  const audiences = Object.fromEntries(CORE_AGENT_TEMPLATES.map((t) => [t.key, t.audience ?? 'everyone']));
  check('templates: Builder and External agent start with their managers; the rest as before', audiences.builder === 'managers' && audiences['external-agent'] === 'managers'
    && audiences['weekly-reporter'] === 'everyone' && audiences['inbox-triage'] === 'everyone' && audiences['personal-assistant'] === 'everyone', audiences);
  check('no em dashes in the migration', !MIGRATION_SQL.includes('\u2014'));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const body = MIGRATION_SQL.trim();
  check('schema.sql: the section is there and mirrors the migration', at > 0 && SCHEMA_SQL.slice(at).includes(body));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  await old.exec('RESET ROLE');
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old bot', 'old@agents.example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id"))[0].id;
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Old task') RETURNING id", [project]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, agent]);
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  // Later sections are not in the schema before it; the later migrations bring them, as on an upgrade.
  await applyMigrationsFrom(old, `${MIGRATION}~`);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const kept = (await q<Loose>('SELECT orchestrator_id, reachable_directly, ask_first FROM pm.team_members WHERE id = $1', [agent]))[0];
  check('upgrade: an existing agent has no orchestrator, is reachable and never asks', kept?.orchestrator_id === null && kept.reachable_directly === true && kept.ask_first === false, kept);
  check('upgrade: no audience rows are made', (await q<Loose>('SELECT count(*)::int AS n FROM pm.agent_audience'))[0].n === 0);
  // What 2.0.49 writes still works.
  const newer = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Newer bot', 'newer@agents.example.com', 'agent') RETURNING id"))[0].id;
  const task2 = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Another') RETURNING id", [project]))[0].id;
  check('upgrade: the previous release adds agents and assigns them as before', (await errorOf(old, 'INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task2, newer])) === null);
  const status = (await q<Loose>('SELECT pm.agent_status($1) AS s', [agent]))[0].s;
  check('agent_status: a company agent reads assistants_off false', status?.agent === true && status.assistants_off === false, status);

  const fnGrants = await q<Loose>(`SELECT p.proname AS name, bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon,
      bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = ANY ($1) GROUP BY p.proname`, [NEW_FUNCTIONS]);
  check('grants: the new functions are callable by neither anon nor signed-in members', fnGrants.length === NEW_FUNCTIONS.length && fnGrants.every((g: Loose) => !g.anon && !g.auth), fnGrants);
  const tableGrants = (await q<Loose>(`SELECT has_table_privilege('anon', 'pm.agent_audience', 'SELECT') AS anon_read,
      has_table_privilege('authenticated', 'pm.agent_audience', 'SELECT') AS member_read,
      has_table_privilege('authenticated', 'pm.agent_audience', 'INSERT') OR has_table_privilege('authenticated', 'pm.agent_audience', 'UPDATE')
        OR has_table_privilege('authenticated', 'pm.agent_audience', 'DELETE') AS member_write`))[0];
  check('grants: members only read the audience; anon nothing', !tableGrants.anon_read && tableGrants.member_read && !tableGrants.member_write, tableGrants);
  await fresh.close();
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, login?: { id: string; email: string }, extra: Record<string, string> = {}) => {
    const cols = Object.keys(extra);
    const id = (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
      [name, login?.email ?? `${name.toLowerCase()}@example.com`, role, ...Object.values(extra)]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const ana = await member('Ana', 'member', LOGINS.ana);
  const ben = await member('Ben', 'member', LOGINS.ben);
  const cara = await member('Cara', 'admin', LOGINS.cara);
  // Dana reviews suggestions but may not assign others (no tasks.manage_all).
  const dana = await member('Dana', 'member', LOGINS.dana);
  const alexa = await member('Alexa', 'agent');
  const dev = await member('Dev', 'agent');
  const junior = await member('Junior', 'agent');
  const free = await member('Free', 'agent');
  const pip = await member('Pip', 'agent', undefined, { delegate_of: ana, assistant_template: 'personal-assistant' });
  const grant = async (memberId: string, permission: string, channel = 'api') =>
    q('INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, $3, \'allow\') ON CONFLICT DO NOTHING', [memberId, permission, channel]);
  for (const m of [ana, ben, cara, owner, alexa, dev, junior, free, pip]) await grant(m, 'tasks.manage_all');
  for (const m of [ana, ben, cara]) for (const p of ['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_all', 'suggestions.manage']) await grant(m, p, 'app');
  for (const m of [ana, ben, cara]) await grant(m, 'suggestions.manage');
  for (const m of [alexa, junior]) await grant(m, 'suggestions.create');
  for (const p of ['projects.read', 'tasks.read', 'tasks.create', 'suggestions.manage']) await grant(dana, p, 'app');
  for (const m of [dev, junior, free]) await grant(m, 'agents.act_for');
  for (const m of [ana, ben, cara, alexa, dev, junior, free, pip]) await grant(m, 'team.read');
  await grant(alexa, 'agents.manage');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Site') RETURNING id"))[0].id;
  for (const m of [owner, ana, ben, cara, dana, alexa, dev, junior, free, pip]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  const eng = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Engineering', 'engineering') RETURNING id"))[0].id;
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [eng, ana]);
  // Cara owns Free; Dev and Junior are owned by Olivia; Alexa by nobody (the workspace Owners).
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2), ($3, $4), ($5, $4)', [free, cara, dev, owner, junior]);
  await q('UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [dev, junior]);
  const task = async (title: string) => (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, ai_readiness) VALUES ($1, $2, 'todo', 'ai_ready') RETURNING id", [project, title]))[0].id;
  const key = async (memberId: string, scopes: string[]) => {
    const value = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(value).digest('hex'), memberId, scopes]);
    return value;
  };
  const WORK = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all', 'projects.read', 'agent_activity.write', 'team.read', 'questions.ask', 'suggestions.manage', 'suggestions.create'];
  const keys = {
    owner: await key(owner, [...WORK, 'team.manage', 'agents.manage', 'api_keys.manage_all']),
    ana: await key(ana, WORK), ben: await key(ben, WORK), cara: await key(cara, WORK),
    alexa: await key(alexa, [...WORK, 'agents.manage']), dev: await key(dev, WORK), junior: await key(junior, WORK), free: await key(free, WORK), pip: await key(pip, WORK),
  };
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES
    ($1, 'slack', 'U_ANA', 'T1', now(), 'admin'), ($2, 'slack', 'U_BEN', 'T1', now(), 'admin')`, [ana, ben]);
  const goal = (await q<{ id: string }>("INSERT INTO pm.project_goals (project_id, title) VALUES ($1, 'Launch') RETURNING id", [project]))[0].id;
  return { q, owner, ana, ben, cara, dana, alexa, dev, junior, free, pip, project, eng, goal, task, key, keys, grant, member };
}
type Seed = Awaited<ReturnType<typeof seed>>;

// ── The chart and the audience in the database ───────────────────────────

async function databaseChecks(db: PGlite, s: Seed) {
  await db.exec('RESET ROLE');
  const agent = async (name: string) => (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, 'agent') RETURNING id", [name, `${name.toLowerCase()}@agents.example.com`]))[0].id;
  const orchestrator = (id: string, orchestratorId: string | null) => errorOf(db, 'UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [orchestratorId, id]);
  check('chart: a loop is refused', /agent_orchestrator_loop/.test(await orchestrator(s.dev, s.junior) ?? ''));
  check('chart: an agent is never its own orchestrator', /team_members_orchestrator_not_self|agent_orchestrator_loop/.test(await orchestrator(s.dev, s.dev) ?? ''));
  const [a1, a2, a3, a4, a5, b1, b2] = [await agent('A1'), await agent('A2'), await agent('A3'), await agent('A4'), await agent('A5'), await agent('B1'), await agent('B2')];
  const four = [await orchestrator(a2, a1), await orchestrator(a3, a2), await orchestrator(a4, a3)];
  check('chart: four levels are fine', four.every((e) => e === null), four);
  check('chart: a fifth level is refused', /agent_orchestrator_too_deep/.test(await orchestrator(a5, a4) ?? ''));
  await orchestrator(b2, b1);
  check('chart: moving an agent with reports under a deep orchestrator is refused when the reports would sit too deep', /agent_orchestrator_too_deep/.test(await orchestrator(b1, a3) ?? ''));
  check('chart: and allowed when they fit', (await orchestrator(b1, a2)) === null);
  check('chart: a personal assistant never has an orchestrator, and is never one', /agent_orchestrator_personal/.test(await orchestrator(s.pip, s.dev) ?? '') && /agent_orchestrator_not_agent/.test(await orchestrator(a5, s.pip) ?? ''));
  const selfAssign = async (id: string) => (await s.q<Loose>('SELECT agent_self_assign AS on FROM pm.team_members WHERE id = $1', [id]))[0].on as boolean;
  const [c1, c2] = [await agent('C1'), await agent('C2')];
  await orchestrator(c1, a1);
  await orchestrator(c2, a1);
  await s.q('UPDATE pm.team_members SET agent_self_assign = true WHERE id = $1', [c2]);
  check('chart: an agent that gets an orchestrator stops picking up unassigned work; a manager can turn it back on', !(await selfAssign(c1)) && await selfAssign(c2));
  const guard = (await s.q<Loose>("SELECT prosrc FROM pg_proc WHERE proname = 'team_members_orchestrator_guard'"))[0]?.prosrc ?? '';
  check('chart: orchestrator changes take one lock, so two moves at once cannot make a loop', /pg_advisory_xact_lock\(hashtext\('pm\.team_members\.orchestrator_id'\)\)/.test(guard));
  check('chart: a person is never an orchestrator and never has one', /agent_orchestrator_not_agent/.test(await orchestrator(a5, s.ben) ?? '') && /agent_orchestrator_agents_only/.test(await orchestrator(s.ben, a1) ?? ''));
  check('audience: a personal assistant has none (its person is its audience)', /agent_audience_agents_only/.test(await errorOf(db, "INSERT INTO pm.agent_audience (agent_id, kind) VALUES ($1, 'everyone')", [s.pip]) ?? ''));
  check('audience: a ref must fit its kind', /agent_audience_ref_check/.test(await errorOf(db, "INSERT INTO pm.agent_audience (agent_id, kind, ref) VALUES ($1, 'role', 'agent')", [a1]) ?? '')
    && /agent_audience_ref_check/.test(await errorOf(db, "INSERT INTO pm.agent_audience (agent_id, kind, ref) VALUES ($1, 'everyone', 'x')", [a1]) ?? ''));

  const may = async (agentId: string, memberId: string) => (await s.q<Loose>('SELECT pm.member_may_use_agent($1, $2) AS ok', [agentId, memberId]))[0].ok as boolean;
  const add = (agentId: string, kind: string, ref: string | null, effect = 'include') => s.q('INSERT INTO pm.agent_audience (agent_id, kind, ref, effect) VALUES ($1, $2, $3, $4)', [agentId, kind, ref, effect]);
  check('audience: no rows lets everyone in', await may(a1, s.ben) && await may(a1, s.ana));
  await add(a1, 'group', s.eng);
  check('audience: a group include lets its members in, no one else', await may(a1, s.ana) && !(await may(a1, s.ben)));
  await add(a1, 'role', 'admin');
  check('audience: a role include adds the role', await may(a1, s.cara) && !(await may(a1, s.ben)));
  await add(a1, 'member', s.ben);
  check('audience: a person include adds the person', await may(a1, s.ben));
  await add(a1, 'member', s.ana, 'exclude');
  check('audience: an exclude wins over the group', !(await may(a1, s.ana)) && await may(a1, s.ben));
  check('audience: an orchestrator\'s audience limits every agent under it (A4 has none of its own)', !(await may(a4, s.ana)) && await may(a4, s.ben) && !(await may(a4, s.owner)));
  await add(a3, 'member', s.cara);
  check('audience: and both levels must let them in', await may(a4, s.cara) && !(await may(a4, s.ben)) && await may(a2, s.ben));
  check('audience: a personal assistant only for its person', await may(s.pip, s.ana) && !(await may(s.pip, s.ben)) && !(await may(s.pip, s.owner)));
  await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [b2]);
  check('audience: never a suspended or missing member', !(await may(a2, b2)) && !(await may(a2, randomUUID())));
  const count = (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.agent_audience_members($1)', [a4]))[0].n;
  check('audience: the members preview counts the people in (Cara only)', count === 1, count);
  const manages = async (agentId: string, memberId: string) => (await s.q<Loose>('SELECT pm.member_manages_agent($1, $2) AS ok', [agentId, memberId]))[0].ok as boolean;
  check('managers: its owner, a workspace Owner; not others; never the agent', await manages(s.free, s.cara) && await manages(s.free, s.owner) && !(await manages(s.free, s.ben)) && !(await manages(s.free, s.free)));
  await s.q("DELETE FROM pm.agent_audience WHERE agent_id = ANY($1)", [[a1, a3]]);
}

// ── The app: assigning as a signed-in person ─────────────────────────────

async function appChecks(db: PGlite, s: Seed) {
  const tasks = { a: await s.task('App task A'), b: await s.task('App task B'), c: await s.task('App task C') };
  await s.q("INSERT INTO pm.agent_audience (agent_id, kind, ref) VALUES ($1, 'group', $2)", [s.dev, s.eng]);
  const save = async (login: { id: string }, taskId: string, assignees: string[]) => {
    await actAs(db, login.id);
    const error = await errorOf(db, 'SELECT pm.save_task($1, $2::jsonb, $3::uuid[])', [taskId, JSON.stringify({}), assignees]);
    await actAs(db, null);
    await db.exec('RESET ROLE');
    return error;
  };
  const anaOk = await save(LOGINS.ana, tasks.a, [s.dev]);
  const benNo = await save(LOGINS.ben, tasks.b, [s.dev]);
  check('app: a person in the audience assigns the agent; someone outside is refused by the database', anaOk === null && /agent_not_available/.test(benNo ?? ''), [anaOk, benNo]);
  check('app: Ben re-saving a task the agent is already on is fine', (await save(LOGINS.ben, tasks.a, [s.dev, s.ben])) === null);
  await s.q('UPDATE pm.team_members SET reachable_directly = false WHERE id = $1', [s.junior]);
  const throughOrchestrator = await save(LOGINS.ana, tasks.b, [s.junior]);
  check('app: an agent only reachable through its orchestrator is refused', /agent_not_available: this agent takes work only through its orchestrator/.test(throughOrchestrator ?? ''), throughOrchestrator);
  await s.q('UPDATE pm.team_members SET reachable_directly = true WHERE id = $1', [s.junior]);
  await s.q('UPDATE pm.team_members SET ask_first = true WHERE id = $1', [s.free]);
  const asks = await save(LOGINS.ben, tasks.c, [s.free]);
  const manager = await save(LOGINS.cara, tasks.b, [s.free]);
  check('app: an agent that asks first refuses a non-manager until approved; its owner just assigns', /agent_ask_first/.test(asks ?? '') && manager === null, [asks, manager]);
  // A forged approval (answered by someone who does not manage the agent) never counts.
  await s.q(`INSERT INTO pm.questions (asked_by, asked_to, question, choices, allow_other, kind, action, status, answer_choice, answered_by, answered_at)
    VALUES ($1, $2, 'Forged', '["approve","reject"]'::jsonb, false, 'approval', $3::jsonb, 'answered', 'approve', $2, now())`,
  [s.ana, s.ben, JSON.stringify({ type: 'agent.use', summary: 'Forged', details: { key: `${s.free}:${s.ben}:task:${tasks.c}` } })]);
  check('app: an approval answered by someone who does not manage the agent does not count', /agent_ask_first/.test(await save(LOGINS.ben, tasks.c, [s.free]) ?? ''));
  // Changing an existing row to point at the agent is checked like a new one.
  const benRow = await s.task('App task D');
  await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [benRow, s.ben]);
  await actAs(db, LOGINS.ben.id);
  const moved = await errorOf(db, 'UPDATE pm.task_assignees SET member_id = $1 WHERE task_id = $2 AND member_id = $3', [s.free, benRow, s.ben]);
  await actAs(db, null);
  await db.exec('RESET ROLE');
  check('app: an UPDATE that points a row at the agent is refused too', /agent_ask_first/.test(moved ?? ''), moved);
  // Personal assistants keep today's behaviour: anyone who could assign one still can.
  check('app: a personal assistant is assigned as before', (await save(LOGINS.ben, tasks.c, [s.pip])) === null);
  await s.q('DELETE FROM pm.task_assignees WHERE task_id = $1 AND member_id = $2', [tasks.c, s.pip]);
  await s.q(`INSERT INTO pm.questions (asked_by, asked_to, question, choices, allow_other, kind, action, status, answer_choice, answered_by, answered_at)
    VALUES ($1, $2, 'App task C', '["approve","reject"]'::jsonb, false, 'approval', $3::jsonb, 'answered', 'approve', $2, now())`,
  [s.ben, s.cara, JSON.stringify({ type: 'agent.use', summary: 'App task C', details: { key: `${s.free}:${s.ben}:task:${tasks.c}` } })]);
  check('app: once a manager approves that task for that person, it goes through', (await save(LOGINS.ben, tasks.c, [s.free])) === null);
  await s.q('UPDATE pm.team_members SET ask_first = false WHERE id = $1', [s.free]);
  await s.q('DELETE FROM pm.agent_audience WHERE agent_id = $1', [s.dev]);
}

// ── End to end ───────────────────────────────────────────────────────────

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  await databaseChecks(db, s);
  await appChecks(db, s);
  const server = await startFakePostgrest(db, { handle: authStandIn(db), userHeader: USER_HEADER });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: APP, APP_ENCRYPTION_KEY: APP_KEY,
  });
  installSession(server.url);
  const providerCalls: { url: string; body: Loose }[] = [];
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const raw = String(init?.body ?? '');
    let body: Loose;
    try { body = JSON.parse(raw || '{}'); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    providerCalls.push({ url, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth.test')) return json({ ok: true, team_id: 'T1', team: 'Acme', user: 'acme-ai', user_id: 'UBOTC01' });
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: `${Date.now()}.0001` });
    return json({ ok: false, error: 'unknown_method' });
  };

  try {
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Task = await import('../src/app/api/v1/tasks/[id]/route');
    const v1Delegate = await import('../src/app/api/v1/tasks/[id]/delegate/route');
    const v1Runs = await import('../src/app/api/v1/agents/runs/route');
    const v1Questions = await import('../src/app/api/v1/questions/route');
    const v1Approvals = await import('../src/app/api/v1/approvals/route');
    const v1Claim = await import('../src/app/api/v1/tasks/[id]/claim/route');
    const v1Suggestions = await import('../src/app/api/v1/task-suggestions/route');
    const v1Approve = await import('../src/app/api/v1/task-suggestions/[id]/approve/route');
    const v1BulkApprove = await import('../src/app/api/v1/task-suggestions/bulk-approve/route');
    const schedulesApi = await import('../src/lib/api/schedules');
    const { replaceAudience } = await import('../src/lib/api/agent-hierarchy');
    const { approveTaskSuggestion } = await import('../src/lib/supabase/queries');
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const { agentRefusalWords, isAskFirstRefusal } = await import('../src/lib/agent-refusal');
    const sessionApprove = await import('../src/app/api/workspace/task-suggestions/[id]/approve/route');
    const goal = s.goal;
    const v1Access = await import('../src/app/api/v1/agents/[id]/access/route');
    const v1Tree = await import('../src/app/api/v1/agents/tree/route');
    const v1Agents = await import('../src/app/api/v1/agents/route');
    const v1Agent = await import('../src/app/api/v1/agents/[id]/route');
    const v1Status = await import('../src/app/api/v1/agents/me/status/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const sessionAccess = await import('../src/app/api/workspace/agents/[id]/access/route');
    const sessionTree = await import('../src/app/api/workspace/agents/tree/route');
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const chatAgentsRoute = await import('../src/app/api/workspace/chat-connections/[id]/agents/route');
    const inboundRoute = await import('../src/app/api/chat/inbound/[id]/route');
    const { hireAgent, sessionCaller } = await import('../src/lib/api/agent-workspace');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text); } catch { body = null; }
      return { status: response.status, body, text };
    };
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      read(await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`${APP}${path}`, {
        method, headers: { 'content-type': 'application/json', origin: APP }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const mcp = async (key: string, body: unknown) => read(await mcpRoute.POST(new NextRequest(`${APP}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'x-api-key': key },
      body: JSON.stringify(body),
    })));
    const callTool = async (key: string, name: string, args: Record<string, unknown>) =>
      (await mcp(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).body?.result?.structuredContent as Loose;
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const assign = (key: string, taskId: string, ids: string[]) => v1(v1Task.PATCH, 'PATCH', `/api/v1/tasks/${taskId}`, { id: taskId }, key, { assignee_ids: ids });
    const delegate = (key: string, taskId: string, body: Loose) => v1(v1Delegate.POST, 'POST', `/api/v1/tasks/${taskId}/delegate`, { id: taskId }, key, body);
    const start = (key: string, body: Loose = {}) => v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, key, body);
    const access = (key: string, id: string) => v1(v1Access.GET, 'GET', `/api/v1/agents/${id}/access`, { id }, key);
    const setAccess = (key: string, id: string, body: Loose) => v1(v1Access.PUT, 'PUT', `/api/v1/agents/${id}/access`, { id }, key, body);
    const assignees = async (taskId: string) => (await s.q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1 ORDER BY member_id', [taskId])).map((r) => r.member_id);
    const approvals = async (agentId: string) => s.q<Loose>("SELECT id, asked_by, asked_to, asked_to_group, status, action FROM pm.questions WHERE kind = 'approval' AND action->>'type' = 'agent.use' AND action->'details'->>'agent_id' = $1 ORDER BY created_at", [agentId]);
    const approve = (id: string, by: string) => s.q("UPDATE pm.questions SET status = 'answered', answer_choice = 'approve', answered_by = $2, answered_at = now() WHERE id = $1", [id, by]);

    // ── Agents with no orchestrator: as before ─────────────────────────────────
    const t1 = await s.task('Write the release notes');
    const benFree = await assign(s.keys.ben, t1, [s.free]);
    check('no orchestrator: a person assigns an agent with no orchestrator and no audience, as before', benFree.status === 200 && (await assignees(t1)).includes(s.free), benFree.body);
    const t2 = await s.task('Check the links');
    const alexaToFree = await delegate(s.keys.alexa, t2, { mode: 'assign', agent_id: s.free });
    check('no orchestrator: any agent hands work to an agent with no orchestrator, as before', alexaToFree.status === 200, alexaToFree.body);

    // ── No skipping levels ─────────────────────────────────────────────
    const t3 = await s.task('Fix the login bug');
    const skipDelegate = await delegate(s.keys.alexa, t3, { mode: 'assign', agent_id: s.junior });
    const skipSubtask = await delegate(s.keys.alexa, t3, { agent_id: s.junior, title: 'Write a test' });
    const skipAssign = await assign(s.keys.alexa, t3, [s.junior]);
    const skipCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.alexa, { project_id: s.project, title: 'Sneak a task to the junior', assignee_ids: [s.junior] });
    const skipMcp = await callTool(s.keys.alexa, 'update_task', { task_id: t3, assignee_ids: [s.junior] });
    check('skip: delegate_task (both modes), task assignment, a new task and MCP all refuse a level skipped (403 not_your_report)',
      [skipDelegate, skipSubtask, skipAssign, skipCreate].every((a) => a.status === 403 && reason(a) === 'not_your_report')
      && skipMcp?.ok === false && JSON.stringify(skipMcp).includes('not_your_report') && !(await assignees(t3)).includes(s.junior),
      [skipDelegate.body, skipSubtask.body, skipAssign.body, skipCreate.body, skipMcp]);
    const orchestratorHands = await delegate(s.keys.dev, t3, { mode: 'assign', agent_id: s.junior });
    check('skip: its own orchestrator hands it the work', orchestratorHands.status === 200 && (await assignees(t3)).includes(s.junior), orchestratorHands.body);

    // ── Who can use it, at every door ──────────────────────────────────
    const setDev = await setAccess(s.keys.owner, s.dev, { audience: [{ kind: 'group', ref: s.eng }] });
    check('access: an Owner limits Dev to Engineering', setDev.status === 200 && setDev.body.data.audience_summary.words === 'Engineering only' && setDev.body.data.people_count === 1, setDev.body);
    const t4 = await s.task('Tune the build');
    const benDev = await assign(s.keys.ben, t4, [s.dev]);
    const benDevCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Speed up CI', assignee_ids: [s.dev] });
    const anaDev = await assign(s.keys.ana, t4, [s.dev]);
    check('audience: someone outside it is refused at assignment and creation (403 agent_not_available); someone in it assigns',
      benDev.status === 403 && reason(benDev) === 'agent_not_available' && benDevCreate.status === 403 && reason(benDevCreate) === 'agent_not_available' && anaDev.status === 200,
      [benDev.body, benDevCreate.body, anaDev.body]);
    await setAccess(s.keys.owner, s.junior, { audience: [{ kind: 'member', ref: s.ben }, { kind: 'member', ref: s.ana }] });
    const t5 = await s.task('Refactor the header');
    const benJunior = await assign(s.keys.ben, t5, [s.junior]);
    const juniorAccess = await access(s.keys.ben, s.junior);
    check('audience: an orchestrator limits the agents under it, whatever their own audience says', benJunior.status === 403 && reason(benJunior) === 'agent_not_available'
      && juniorAccess.body?.data?.inherited_words === 'Limited by Dev: Engineering only.' && juniorAccess.body.data.people_count === 1 && juniorAccess.body.data.orchestrator?.id === s.dev, [benJunior.body, juniorAccess.body]);
    await setAccess(s.keys.owner, s.free, { audience: [{ kind: 'role', ref: 'admin' }, { kind: 'everyone', effect: 'exclude' }] });
    const t6 = await s.task('Count the invoices');
    const caraNoOne = await assign(s.keys.cara, t6, [s.free]);
    await setAccess(s.keys.owner, s.free, { audience: [{ kind: 'role', ref: 'admin' }] });
    const caraAdmin = await assign(s.keys.cara, t6, [s.free]);
    const benRole = await assign(s.keys.ben, await s.task('Another'), [s.free]);
    check('audience: by role, and an exclude of everyone shuts it to all', caraNoOne.status === 403 && caraAdmin.status === 200 && benRole.status === 403, [caraNoOne.body, caraAdmin.body, benRole.body]);
    // Work with no person never reaches a restricted agent, except from its own orchestrator.
    const personless = await assign(s.keys.alexa, await s.task('Audit the books'), [s.free]);
    check('person-less: an agent working on its own cannot reach an agent that has an audience (403 needs_person)', personless.status === 403
      && personless.body?.error?.details?.why === 'needs_person', personless.body);
    // Replacing the audience is all or nothing: a row the table refuses leaves the old audience.
    let replaceFailed = false;
    try {
      await replaceAudience(service, s.free, [{ kind: 'role', ref: 'owner', effect: 'include' }, { kind: 'role', ref: 'agent' as never, effect: 'include' }], s.owner);
    } catch { replaceFailed = true; }
    const kept = await s.q<Loose>('SELECT kind, ref FROM pm.agent_audience WHERE agent_id = $1', [s.free]);
    check('audience: a failed replace keeps the old rows (one transaction)', replaceFailed && kept.length === 1 && kept[0].ref === 'admin', kept);
    await setAccess(s.keys.owner, s.free, { audience: [] });

    // Personal assistants keep today's behaviour.
    const t7 = await s.task('Book the venue');
    const benPip = await assign(s.keys.ben, t7, [s.pip]);
    const alexaPip = await assign(s.keys.alexa, await s.task('Book the band'), [s.pip]);
    const anaPip = await assign(s.keys.ana, await s.task('Book the room'), [s.pip]);
    check('personal: anyone who could assign a personal assistant still can, and so can an agent working on its own', benPip.status === 200
      && alexaPip.status === 200 && anaPip.status === 200, [benPip.body, alexaPip.body, anaPip.body]);

    // ── A three-level chain, checked at every hop ──────────────────────
    const t8 = await s.task('Ship the pricing page');
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [t8, s.pip]);
    const pipRun: string = (await start(s.keys.pip, { task_id: t8, title: 'For Ana' })).body?.data?.id;
    const toDev = await delegate(s.keys.pip, t8, { mode: 'assign', agent_id: s.dev, run_id: pipRun });
    const devRun = await start(s.keys.dev, { task_id: t8, parent_run_id: pipRun, title: 'Plan it' });
    const sub = await delegate(s.keys.dev, t8, { agent_id: s.junior, title: 'Build the table', run_id: devRun.body?.data?.id });
    const juniorRun = await start(s.keys.junior, { task_id: sub.body?.data?.task_id, parent_run_id: devRun.body?.data?.id, title: 'Build' });
    check('chain: Ana, her assistant, Dev, Junior: every hop allowed for Ana', toDev.status === 200 && devRun.status === 201 && sub.status === 201 && juniorRun.status === 201,
      [toDev.body, devRun.body, sub.body, juniorRun.body]);
    // Ana leaves Engineering: the middle level no longer admits her.
    await s.q('DELETE FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [s.eng, s.ana]);
    const sub2 = await delegate(s.keys.dev, t8, { agent_id: s.junior, title: 'Polish the table', run_id: devRun.body?.data?.id });
    const juniorRun2 = await start(s.keys.junior, { task_id: sub.body?.data?.task_id, parent_run_id: devRun.body?.data?.id, title: 'Polish' });
    check('chain: removed at a middle level, the next hop and the next child run are refused for her', sub2.status === 403 && reason(sub2) === 'agent_not_available'
      && juniorRun2.status === 403 && reason(juniorRun2) === 'agent_not_available', [sub2.body, juniorRun2.body]);
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [s.eng, s.ana]);
    // A child run from an agent that is not its orchestrator: Alexa asks Junior something, Junior links its run under hers.
    const alexaRun: string = (await start(s.keys.alexa, { title: 'Survey the code' })).body?.data?.id;
    const asked = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.alexa, { asked_to: s.junior, question: 'Which tests are flaky?', run_id: alexaRun });
    const linked = await start(s.keys.junior, { parent_run_id: alexaRun, title: 'Answer Alexa' });
    check('run start: an asked agent linking its answer under the run that asked it is an answer, not new work (201)', asked.status === 201 && linked.status === 201, [asked.body, linked.body]);
    // A run it was neither handed nor asked about (seen through agents.manage) is new work: only from its orchestrator.
    await s.grant(s.junior, 'agents.manage');
    const juniorManage = await s.key(s.junior, ['tasks.read', 'tasks.manage_all', 'projects.read', 'agent_activity.write', 'team.read', 'agents.manage']);
    const otherRun: string = (await start(s.keys.alexa, { title: 'Plan the quarter' })).body?.data?.id;
    const bypassRun = await start(juniorManage, { parent_run_id: otherRun, title: 'Sneak under Alexa' });
    check('run start: a child run under an agent that is not its orchestrator, and did not ask it, is refused (403 not_your_report)', bypassRun.status === 403 && reason(bypassRun) === 'not_your_report', bypassRun.body);
    // Down the chart only: Junior (under Dev) hands nothing sideways; asking is fine.
    const sideways = await delegate(s.keys.junior, await s.task('Sideways'), { mode: 'assign', agent_id: s.free });
    const askFree = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.junior, { asked_to: s.free, question: 'Can you review my table?' });
    check('down the chart: an agent with an orchestrator hands work only to its own reports (403 not_your_report); asking another agent is fine', sideways.status === 403
      && reason(sideways) === 'not_your_report' && askFree.status === 201, [sideways.body, askFree.body]);
    // Self-pull: under an orchestrator, it picks up nothing unassigned until a manager lets it.
    const loose = await s.task('Loose end');
    const pull = await v1(v1Claim.POST, 'POST', `/api/v1/tasks/${loose}/claim`, { id: loose }, s.keys.junior, {});
    const selfCreate = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.junior, { project_id: s.project, title: 'My own thing', assignee_ids: [s.junior] });
    await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.junior}`, { id: s.junior }, s.keys.owner, { rules: { self_assign: true } });
    const pullAfter = await v1(v1Claim.POST, 'POST', `/api/v1/tasks/${loose}/claim`, { id: loose }, s.keys.junior, {});
    check('self-pull: under an orchestrator, claiming unassigned work and taking a new task itself are refused until a manager turns pick-up on', pull.status === 403
      && reason(pull) === 'self_assign_off' && selfCreate.status === 403 && reason(selfCreate) === 'self_assign_off' && [200, 201].includes(pullAfter.status), [pull.body, selfCreate.body, pullAfter.body]);
    await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.junior}`, { id: s.junior }, s.keys.owner, { rules: { self_assign: false } });
    // A key that makes tasks only for itself: breaking down a task it holds is fine; a new task of its own is refused with a hint it can follow.
    const juniorOwnKey = await s.key(s.junior, ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read']);
    const held = await s.task('Held by Junior');
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [held, s.junior]);
    const breakdown = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, juniorOwnKey, { parent_task_id: held, title: 'Step one' });
    const ownTop = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, juniorOwnKey, { project_id: s.project, title: 'Something new' });
    check('self-pull: a sub-agent breaks down a task it holds into subtasks; a new task of its own is refused with a hint it can follow', breakdown.status === 201
      && ownTop.status === 403 && reason(ownTop) === 'self_assign_off' && /subtask of a task you are on/.test(ownTop.body?.error?.details?.hint ?? '')
      && !/Leave yourself off/.test(ownTop.body?.error?.details?.hint ?? ''), [breakdown.body, ownTop.body]);

    // ── Reachable directly ─────────────────────────────────────────────
    await setAccess(s.keys.owner, s.junior, { reachable_directly: false, audience: [] });
    const t9 = await s.task('Rename the button');
    const direct = await assign(s.keys.ana, t9, [s.junior]);
    const viaOrchestrator = await delegate(s.keys.dev, t9, { mode: 'assign', agent_id: s.junior });
    check('reachable: off, a person is sent to its orchestrator; its orchestrator still hands it work', direct.status === 403 && direct.body?.error?.details?.why === 'only_through_orchestrator' && viaOrchestrator.status === 200, [direct.body, viaOrchestrator.body]);

    // ── Ask first ──────────────────────────────────────────────────────
    await setAccess(s.keys.owner, s.free, { ask_first: true });
    const t10 = await s.task('Reconcile March');
    const first = await assign(s.keys.ben, t10, [s.free]);
    const again = await assign(s.keys.ben, t10, [s.free]);
    const viaMcp = await callTool(s.keys.ben, 'update_task', { task_id: t10, assignee_ids: [s.free] });
    const asks = await approvals(s.free);
    check('ask first: one approval asked of its owner, 202 with its id, and nothing changes', first.status === 202 && first.body?.data?.status === 'awaiting_approval'
      && again.status === 202 && again.body.data.approval_id === first.body.data.approval_id && asks.length === 1 && asks[0].asked_to === s.cara && asks[0].asked_by === s.ben
      && !(await assignees(t10)).includes(s.free) && JSON.stringify(viaMcp ?? {}).includes(first.body.data.approval_id), [first.body, again.body, asks, viaMcp]);
    const managerAssigns = await assign(s.keys.cara, await s.task('Close April'), [s.free]);
    check('ask first: its manager never waits', managerAssigns.status === 200, managerAssigns.body);
    if (asks[0]) await approve(asks[0].id, s.cara);
    const afterApproval = await assign(s.keys.ben, t10, [s.free]);
    check('ask first: once approved, the same request goes through', afterApproval.status === 200 && (await assignees(t10)).includes(s.free), afterApproval.body);
    const delegated = await delegate(s.keys.alexa, await s.task('File the receipts'), { mode: 'assign', agent_id: s.free });
    const fromAgent = await approvals(s.free);
    check('ask first: an agent handing it work waits too (202, asked by that agent)', delegated.status === 202 && fromAgent.length === 2 && fromAgent[1].asked_by === s.alexa, [delegated.body, fromAgent]);
    // Owned by a group only: the group is asked. Owned by nobody: an Owner.
    const groupOwned = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, ask_first) VALUES ('Ledger', 'ledger@agents.example.com', 'agent', true) RETURNING id"))[0].id;
    const nobody = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, ask_first) VALUES ('Orphan', 'orphan@agents.example.com', 'agent', true) RETURNING id"))[0].id;
    const finance = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Finance', 'finance') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [finance, s.cara]);
    await s.q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [groupOwned, finance]);
    for (const a of [groupOwned, nobody]) await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.project, a]);
    const toGroup = await assign(s.keys.ben, await s.task('Pay the rent'), [groupOwned]);
    const toOwner = await assign(s.keys.ben, await s.task('Pay the bills'), [nobody]);
    const g = (await approvals(groupOwned))[0];
    const o = (await approvals(nobody))[0];
    check('ask first: the right managers: a group that owns it, else an Owner', toGroup.status === 202 && g?.asked_to_group === finance && g.asked_to === null
      && toOwner.status === 202 && o?.asked_to === s.owner, [toGroup.body, g, toOwner.body, o]);

    // Two requests at once make one approval.
    const tRace = await s.task('Race me');
    const [r1, r2] = await Promise.all([assign(s.keys.ben, tRace, [s.free]), assign(s.keys.ben, tRace, [s.free])]);
    const raceRows = (await approvals(s.free)).filter((a) => a.action?.details?.target === `task:${tRace}`);
    check('ask first: two requests at once make one approval', r1.status === 202 && r2.status === 202 && r1.body.data.approval_id === r2.body.data.approval_id && raceRows.length === 1, [r1.body, r2.body, raceRows]);
    // Nobody forges one: agent.use is the app's own, and only a manager's answer counts.
    const forgedAsk = await v1(v1Approvals.POST, 'POST', '/api/v1/approvals', {}, s.keys.ben, { action: { type: 'agent.use', summary: 'Let me use Free', details: { key: `${s.free}:${s.ben}:task:${tRace}` } } });
    if (r1.body?.data?.approval_id) await approve(r1.body.data.approval_id, s.ana);
    const afterForged = await assign(s.keys.ben, tRace, [s.free]);
    check('ask first: agent.use cannot be asked for by hand (422), and an approval decided by a non-manager does not count', forgedAsk.status === 422
      && reason(forgedAsk) === 'reserved_action_type' && afterForged.status === 202 && !(await assignees(tRace)).includes(s.free), [forgedAsk.body, afterForged.body]);
    // A manager's reject stands for a day.
    const tReject = await s.task('Reject me');
    const ask1 = await assign(s.keys.ben, tReject, [s.free]);
    await s.q("UPDATE pm.questions SET status = 'answered', answer_choice = 'reject', answered_by = $2, answered_at = now() WHERE id = $1", [ask1.body?.data?.approval_id, s.cara]);
    const declinedTry = await assign(s.keys.ben, tReject, [s.free]);
    await s.q("UPDATE pm.questions SET answered_at = now() - interval '25 hours' WHERE id = $1", [ask1.body?.data?.approval_id]);
    const dayLater = await assign(s.keys.ben, tReject, [s.free]);
    check('ask first: a manager\'s reject answers 403 agent_use_declined for a day, then the person may ask again', declinedTry.status === 403 && reason(declinedTry) === 'agent_use_declined'
      && dayLater.status === 202 && dayLater.body.data.approval_id !== ask1.body?.data?.approval_id, [declinedTry.body, dayLater.body]);
    // Approvals are used up: a task's covers that task only; a new task's (by title) is single use.
    const otherTask = await assign(s.keys.ben, await s.task('Not March'), [s.free]);
    check('ask first: the approval for one task does not cover another', otherTask.status === 202, otherTask.body);
    const create = () => v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Close the quarter', assignee_ids: [s.free] });
    const newAsk = await create();
    if (newAsk.body?.data?.approval_id) await approve(newAsk.body.data.approval_id, s.cara);
    const made = await create();
    const madeAgain = await create();
    check('ask first: a new task\'s approval makes one task, then asks again', newAsk.status === 202 && made.status === 201 && madeAgain.status === 202
      && madeAgain.body.data.approval_id !== newAsk.body.data.approval_id, [newAsk.body, made.status, madeAgain.body]);

    // Approving a suggestion assigns its agent for the approver, checked before any task is made.
    const suggestion = async (assignedTo: string, title: string) => (await s.q<{ id: string }>(
      "INSERT INTO pm.task_suggestions (project_id, proposed_by, assigned_to, title, description, reasoning, status) VALUES ($1, $2, $3, $4, '', '', 'pending') RETURNING id",
      [s.project, s.alexa, assignedTo, title]))[0].id;
    const tasksCalled = async (title: string) => (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.tasks WHERE title = $1', [title]))[0].n as number;
    await setAccess(s.keys.owner, s.dev, { audience: [{ kind: 'group', ref: s.eng }] });
    const sDev = await suggestion(s.dev, 'Suggested for Dev');
    const sFree = await suggestion(s.free, 'Suggested for Free');
    const approveDev = await v1(v1Approve.POST, 'POST', `/api/v1/task-suggestions/${sDev}/approve`, { id: sDev }, s.keys.ben, {});
    const approveFree = await v1(v1Approve.POST, 'POST', `/api/v1/task-suggestions/${sFree}/approve`, { id: sFree }, s.keys.ben, {});
    const bulk = await v1(v1BulkApprove.POST, 'POST', '/api/v1/task-suggestions/bulk-approve', {}, s.keys.ben, { ids: [sDev, sFree] });
    const pendingStill = (await s.q<Loose>('SELECT status FROM pm.task_suggestions WHERE id = ANY($1)', [[sDev, sFree]])).every((r: Loose) => r.status === 'pending');
    check('suggestions: approving one for an agent the approver may not use is refused (403), one that asks first waits (202), bulk says so; no task is made',
      approveDev.status === 403 && reason(approveDev) === 'agent_not_available' && approveFree.status === 202 && approveFree.body?.data?.status === 'awaiting_approval'
      && bulk.body?.data?.approved === 0 && (bulk.body?.data?.results ?? []).some((r: Loose) => r.reason === 'ask_first') && (bulk.body?.data?.results ?? []).some((r: Loose) => r.reason === 'agent_not_available')
      && pendingStill && await tasksCalled('Suggested for Dev') === 0 && await tasksCalled('Suggested for Free') === 0, [approveDev.body, approveFree.body, bulk.body]);
    const proposeDev = await v1(v1Suggestions.POST, 'POST', '/api/v1/task-suggestions', {}, s.keys.junior, { project_id: s.project, goal_id: goal, title: 'Junior suggests Dev', description: 'Dev should do this', reasoning: 'It is Dev work', assigned_to: s.dev });
    check('suggestions: an agent cannot propose one for an agent it may not hand work to (403)', proposeDev.status === 403 && reason(proposeDev) === 'not_your_report', proposeDev.body);
    // In the app the database refuses the assignee, and no unassigned task is left behind.
    const browserBen = createPmClient(server.url, 'fake-anon-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { [USER_HEADER]: LOGINS.ben.id } } });
    // The fake PostgREST reads whole rows and projects them, so members need every projects column here (the real one reads only the granted ones).
    await s.q('GRANT SELECT ON pm.projects TO authenticated');
    let browserError = '';
    try {
      await approveTaskSuggestion(browserBen, sDev, {}, s.ben);
    } catch (error) { browserError = agentRefusalWords(error) ?? JSON.stringify(error); }
    await s.q('REVOKE SELECT ON pm.projects FROM authenticated');
    await s.q('GRANT SELECT (archived_at, autonomous_enabled, color, created_at, created_by, deleted_at, deleted_by, description, due_date, hourly_tracking, id, integration_branch, name, start_date, status, time_tracking_enabled, updated_at) ON pm.projects TO authenticated');
    const sDevRow = (await s.q<Loose>('SELECT status FROM pm.task_suggestions WHERE id = $1', [sDev]))[0];
    check('suggestions: in the app, the refusal reaches the person, no task is made and the suggestion stays pending', /cannot give this agent work/i.test(browserError)
      && await tasksCalled('Suggested for Dev') === 0 && sDevRow?.status === 'pending', [browserError, sDevRow]);

    // In the app, a suggestion for an agent that asks first: its managers are asked, the suggestion stays pending,
    // and once one of them approved it the person approves the suggestion.
    await s.q('GRANT SELECT ON pm.projects TO authenticated');
    let askErr: unknown = null;
    try { await approveTaskSuggestion(browserBen, sFree, {}, s.ben); } catch (error) { askErr = error; }
    await s.q('REVOKE SELECT ON pm.projects FROM authenticated');
    await s.q('GRANT SELECT (archived_at, autonomous_enabled, color, created_at, created_by, deleted_at, deleted_by, description, due_date, hourly_tracking, id, integration_branch, name, start_date, status, time_tracking_enabled, updated_at) ON pm.projects TO authenticated');
    signedIn = LOGINS.ben;
    const sentToManagers = await session(sessionApprove.POST, 'POST', `/api/workspace/task-suggestions/${sFree}/approve`, { id: sFree }, {});
    const freeAsk = (await approvals(s.free)).find((a) => a.action?.details?.target === `suggestion:${sFree}`);
    const sFreePending = (await s.q<Loose>('SELECT status FROM pm.task_suggestions WHERE id = $1', [sFree]))[0]?.status;
    if (freeAsk) await approve(freeAsk.id, s.cara);
    const approvedInApp = await session(sessionApprove.POST, 'POST', `/api/workspace/task-suggestions/${sFree}/approve`, { id: sFree }, {});
    signedIn = LOGINS.owner;
    const appTask = approvedInApp.body?.data?.task;
    check('suggestions in the app: an ask-first agent sends it to its managers (suggestion pending), then the person approves it', isAskFirstRefusal(askErr)
      && sentToManagers.status === 200 && sentToManagers.body?.data?.status === 'awaiting_approval' && sentToManagers.body.data.agent_name === 'Free'
      && freeAsk?.asked_to === s.cara && sFreePending === 'pending' && approvedInApp.status === 200 && (appTask?.assignee_ids ?? []).includes(s.free),
    [String((askErr as Loose)?.message), sentToManagers.body, freeAsk, sFreePending, approvedInApp.body]);
    // A reviewer who may not assign others (no tasks.manage_all) gets the task unassigned, as before, not an error.
    const sOpen = await suggestion(s.alexa, 'Suggested for Alexa');
    const browserDana = createPmClient(server.url, 'fake-anon-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { [USER_HEADER]: LOGINS.dana.id } } });
    await s.q('GRANT SELECT ON pm.projects TO authenticated');
    let danaResult: Loose = null;
    let danaError = '';
    try { danaResult = await approveTaskSuggestion(browserDana, sOpen, {}, s.dana); } catch (error) { danaError = JSON.stringify(error); }
    await s.q('REVOKE SELECT ON pm.projects FROM authenticated');
    await s.q('GRANT SELECT (archived_at, autonomous_enabled, color, created_at, created_by, deleted_at, deleted_by, description, due_date, hourly_tracking, id, integration_branch, name, start_date, status, time_tracking_enabled, updated_at) ON pm.projects TO authenticated');
    const danaTask = danaResult?.task?.id ? (await s.q<Loose>('SELECT array(SELECT member_id::text FROM pm.task_assignees WHERE task_id = $1) AS people', [danaResult.task.id]))[0] : null;
    check('suggestions in the app: a reviewer without tasks.manage_all approves and the task is made unassigned, as before', !danaError && !!danaResult?.task?.id
      && (danaTask?.people ?? []).length === 0 && danaResult.suggestion?.status === 'approved', [danaError, danaResult?.suggestion?.status, danaTask]);

    // New-task approvals are used only by a task that is made.
    const usedAt = async (id: string) => (await s.q<Loose>('SELECT used_at FROM pm.questions WHERE id = $1', [id]))[0]?.used_at ?? null;
    const claimA = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Claim A', assignee_ids: [s.free] });
    if (claimA.body?.data?.approval_id) await approve(claimA.body.data.approval_id, s.cara);
    const claimAFails = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Claim A', assignee_ids: [s.free], blocked_by_ids: [randomUUID()] });
    const claimAUnused = await usedAt(claimA.body?.data?.approval_id);
    const claimAMade = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Claim A', assignee_ids: [s.free] });
    check('approvals: a later check that fails leaves the approval unused; the next try makes the task', claimAFails.status === 400 && claimAUnused === null
      && claimAMade.status === 201 && (await usedAt(claimA.body?.data?.approval_id)) !== null, [claimAFails.body, claimAUnused, claimAMade.body]);
    await s.q("UPDATE pm.team_members SET agent_create_policy = 'approval' WHERE id = $1", [s.alexa]);
    const claimB = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.alexa, { project_id: s.project, title: 'Claim B', assignee_ids: [s.free] });
    if (claimB.body?.data?.approval_id) await approve(claimB.body.data.approval_id, s.cara);
    const claimBSuggested = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.alexa, { project_id: s.project, title: 'Claim B', assignee_ids: [s.free] });
    const claimBUnused = await usedAt(claimB.body?.data?.approval_id);
    await s.q("UPDATE pm.team_members SET agent_create_policy = 'live' WHERE id = $1", [s.alexa]);
    const claimBMade = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.alexa, { project_id: s.project, title: 'Claim B', assignee_ids: [s.free] });
    check('approvals: a create that becomes a suggestion leaves the approval unused', claimB.status === 202 && claimBSuggested.status === 202
      && claimBSuggested.body?.data?.needs_approval === true && claimBUnused === null && claimBMade.status === 201, [claimBSuggested.body, claimBUnused, claimBMade.body]);
    const claimC = () => v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.ben, { project_id: s.project, title: 'Claim C', assignee_ids: [s.free, groupOwned] });
    const claimC1 = await claimC();
    if (claimC1.body?.data?.approval_id) await approve(claimC1.body.data.approval_id, s.cara);
    const claimC2 = await claimC();
    const freeUnused = await usedAt(claimC1.body?.data?.approval_id);
    if (claimC2.body?.data?.approval_id) await approve(claimC2.body.data.approval_id, s.cara);
    const claimC3 = await claimC();
    check('approvals: when a second agent waits, the first agent\'s approval stays unused; with both approved the task is made', claimC1.body?.data?.agent_id === s.free
      && claimC2.status === 202 && claimC2.body?.data?.agent_id === groupOwned && freeUnused === null && claimC3.status === 201, [claimC1.body, claimC2.body, freeUnused, claimC3.body]);
    await setAccess(s.keys.owner, s.free, { ask_first: false });

    // A repeat re-checks: an agent whoever runs it may no longer use stays off the copy, and its managers hear.
    const weekly = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, due_date, created_by) VALUES ($1, 'Weekly ledger', 'todo', '2026-12-07', $2) RETURNING id", [s.project, s.owner]))[0].id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [weekly, s.free]);
    const ownerCaller = { memberId: s.owner, access: (await resolveMemberAccess(service, s.owner))!, scopes: null };
    await schedulesApi.setTaskRepeat(service, ownerCaller, weekly, { recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }, mode: 'schedule' }, new Date('2026-12-01T15:00:00Z'));
    await setAccess(s.keys.owner, s.free, { audience: [{ kind: 'role', ref: 'admin' }] });
    await s.q("UPDATE pm.schedules SET next_run_at = now() - interval '1 minute' WHERE kind = 'task' AND task_id = $1", [weekly]);
    await schedulesApi.runDueSchedules(service, new Date());
    const copyRow = (await s.q<Loose>(`SELECT t.id, array(SELECT member_id::text FROM pm.task_assignees WHERE task_id = t.id) AS people
      FROM pm.tasks t WHERE t.title = 'Weekly ledger' AND t.id <> $1`, [weekly]))[0];
    const told = (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1 AND title = 'A repeat was left unassigned'", [s.cara]))[0].n;
    check('repeat: the copy is made without an agent the runner may no longer use, and its manager is told', !!copyRow && !(copyRow.people ?? []).includes(s.free) && told === 1, [copyRow, told]);
    await setAccess(s.keys.owner, s.free, { audience: [] });

    // ── Moving an agent ────────────────────────────────────────────────
    const runsBefore = (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.agent_runs WHERE agent_id = $1', [s.junior]))[0].n;
    const moved = await setAccess(s.keys.owner, s.junior, { orchestrator_id: s.alexa, reachable_directly: true });
    const runsAfter = (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.agent_runs WHERE agent_id = $1', [s.junior]))[0].n;
    const t11 = await s.task('Move test');
    const oldOrchestrator = await delegate(s.keys.dev, t11, { mode: 'assign', agent_id: s.junior });
    const newOrchestrator = await delegate(s.keys.alexa, t11, { mode: 'assign', agent_id: s.junior });
    check('move: a new orchestrator; its tasks and runs stay; the old orchestrator can no longer hand it work, the new one can', moved.status === 200 && moved.body.data.orchestrator_id === s.alexa
      && (await assignees(t3)).includes(s.junior) && (await assignees(t9)).includes(s.junior) && runsBefore === runsAfter
      && oldOrchestrator.status === 403 && reason(oldOrchestrator) === 'not_your_report' && newOrchestrator.status === 200, [moved.body, oldOrchestrator.body, newOrchestrator.body]);

    // ── The access API ─────────────────────────────────────────────────
    const byBen = await setAccess(s.keys.ben, s.junior, { ask_first: true });
    const bySelf = await setAccess(s.keys.junior, s.junior, { ask_first: true });
    const loop = await setAccess(s.keys.owner, s.alexa, { orchestrator_id: s.junior });
    const personal = await setAccess(s.keys.owner, s.pip, { audience: [] });
    const badGroup = await setAccess(s.keys.owner, s.dev, { audience: [{ kind: 'group', ref: randomUUID() }] });
    const agentRef = await setAccess(s.keys.owner, s.dev, { audience: [{ kind: 'member', ref: s.alexa }] });
    check('api: only managers change it (403 not_agent_owner), never the agent itself (403 own_access)', byBen.status === 403 && reason(byBen) === 'not_agent_owner' && bySelf.status === 403 && reason(bySelf) === 'own_access', [byBen.body, bySelf.body]);
    check('api: a loop, a personal assistant, a group in Trash or missing, an agent as audience are refused (422)', loop.status === 422 && reason(loop) === 'orchestrator_loop'
      && personal.status === 422 && reason(personal) === 'personal_agent' && badGroup.status === 422 && reason(badGroup) === 'audience_group_not_found'
      && agentRef.status === 422 && reason(agentRef) === 'audience_member_not_person', [loop.body, personal.body, badGroup.body, agentRef.body]);
    const deep = [await s.member('L1', 'agent'), await s.member('L2', 'agent'), await s.member('L3', 'agent'), await s.member('L4', 'agent'), await s.member('L5', 'agent')];
    for (let i = 1; i < 4; i++) await setAccess(s.keys.owner, deep[i], { orchestrator_id: deep[i - 1] });
    const tooDeep = await setAccess(s.keys.owner, deep[4], { orchestrator_id: deep[3] });
    check('api: a fifth level is refused (422 orchestrator_too_deep)', tooDeep.status === 422 && reason(tooDeep) === 'orchestrator_too_deep', tooDeep.body);
    const tree = await v1(v1Tree.GET, 'GET', '/api/v1/agents/tree', {}, s.keys.ben);
    const node = (id: string) => (tree.body?.data?.agents ?? []).find((n: Loose) => n.id === id);
    check('tree: orchestrators first, each with its reports and depth; personal assistants left out', tree.status === 200 && node(s.alexa)?.depth === 0 && node(s.junior)?.depth === 1
      && node(s.junior)?.orchestrator_id === s.alexa && node(s.alexa)?.report_ids?.includes(s.junior) && node(deep[3])?.depth === 3 && !node(s.pip) && tree.body.data.max_levels === 4, tree.body?.data);
    const mcpTree = await callTool(s.keys.ben, 'get_agent_tree', {});
    const mcpAccess = await callTool(s.keys.ben, 'get_agent_access', { agent_id: s.dev });
    const mcpSet = await callTool(s.keys.owner, 'set_agent_access', { agent_id: s.dev, audience: [{ kind: 'group', ref: s.eng }, { kind: 'member', ref: s.ben, effect: 'exclude' }] });
    check('mcp: get_agent_tree, get_agent_access and set_agent_access answer as the routes do', mcpTree?.ok === true && mcpTree.data?.agents?.length === tree.body.data.agents.length
      && mcpAccess?.ok === true && mcpAccess.data?.audience_summary?.words === 'Engineering only'
      && mcpSet?.ok === true && mcpSet.data?.audience_summary?.words === 'Engineering, except Ben', [mcpTree, mcpAccess, mcpSet]);
    const list = await v1(v1Agents.GET, 'GET', '/api/v1/agents?limit=100', {}, s.keys.ben);
    const listed = (list.body?.data ?? []).find((a: Loose) => a.id === s.junior);
    const detail = await v1(v1Agent.GET, 'GET', `/api/v1/agents/${s.dev}`, { id: s.dev }, s.keys.ben);
    check('list and detail: orchestrator_id, reachable_directly, ask_first and audience_summary', listed?.orchestrator_id === s.alexa && listed.reachable_directly === true && listed.audience_summary?.limited === false
      && detail.body?.data?.orchestrator_id === null && detail.body.data.audience_summary?.words === 'Engineering, except Ben' && detail.body.data.ask_first === false, [listed, detail.body?.data?.audience_summary]);

    // Session routes, as a signed-in person.
    signedIn = LOGINS.ana;
    const seen = await session(sessionAccess.GET, 'GET', `/api/workspace/agents/${s.dev}/access`, { id: s.dev });
    const anaSets = await session(sessionAccess.PUT, 'PUT', `/api/workspace/agents/${s.dev}/access`, { id: s.dev }, { ask_first: true });
    const anaTree = await session(sessionTree.GET, 'GET', '/api/workspace/agents/tree');
    signedIn = LOGINS.owner;
    const ownerSets = await session(sessionAccess.PUT, 'PUT', `/api/workspace/agents/${s.dev}/access`, { id: s.dev }, { audience: [] });
    check('session: the Access section reads people_words and the tree; a non-manager cannot change it; an Owner can', seen.status === 200 && seen.body?.data?.people_words === '1 person can use it'
      && seen.body.data.can_manage === false && anaSets.status === 403 && anaTree.status === 200 && anaTree.body?.data?.agents?.length > 0
      && ownerSets.status === 200 && ownerSets.body?.data?.audience_summary?.limited === false && ownerSets.body.data.people_words === '5 people can use it', [seen.body, anaSets.body, ownerSets.body]);

    // ── Chat and mentions ──────────────────────────────────────────────
    signedIn = LOGINS.owner;
    const company = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', kind: 'company', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
    const companyId = company.body?.data?.id as string;
    const setAgents = await session(chatAgentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${companyId}/agents`, { id: companyId }, { agent_ids: [s.dev, s.junior, s.free], default_agent_id: s.dev });
    check('chat: the company bot reaches Dev, Junior and Free', company.status === 201 && setAgents.status === 200, [company.body, setAgents.body]);
    let seq = 0;
    const say = async (user: string, text: string, channel = `D_${user}`) => {
      seq++;
      const body = { type: 'event_callback', team_id: 'T1', event_id: `EvH${seq}`, event: { type: 'message', channel_type: 'im', user, text, channel, ts: `17100000${seq}.000100` } };
      const ts = String(Math.floor(Date.now() / 1000));
      providerCalls.length = 0;
      const answer = await read(await inboundRoute.POST(new Request(`${APP}/api/chat/inbound/${companyId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(SLACK_SECRET, ts, JSON.stringify(body)) }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: companyId }) }));
      const posted = providerCalls.filter((c) => c.url.endsWith('/chat.postMessage')).map((c) => String(c.body?.text ?? ''));
      return { answer, posted };
    };
    await setAccess(s.keys.owner, s.dev, { audience: [{ kind: 'group', ref: s.eng }] });
    const benMention = await say('U_BEN', '@Dev can you look at the build?');
    const benDefault = await say('U_BEN', 'hello there');
    const anaMention = await say('U_ANA', '@Dev can you look at the build?');
    const benRow = (await s.q<Loose>('SELECT agent_id, status FROM pm.chat_messages WHERE id = $1', [benMention.answer.body?.id]))[0];
    check('chat: a mention from someone outside the audience is not sent to the agent, and they are told why', benMention.answer.body?.status === 'unrouted' && benRow?.agent_id === null
      && benMention.posted.some((t) => /Dev is not available to you/.test(t)), [benMention, benRow]);
    check('chat: a DM to the default agent is checked the same way; someone in the audience gets through', benDefault.answer.body?.status === 'unrouted'
      && ['pending', 'notified'].includes(anaMention.answer.body?.status), [benDefault.answer.body, anaMention.answer.body]);
    await setAccess(s.keys.owner, s.junior, { orchestrator_id: s.dev, reachable_directly: false });
    const viaOrchestratorChat = await say('U_ANA', '@Junior quick question');
    check('chat: an agent only reachable through its orchestrator points to the orchestrator', viaOrchestratorChat.answer.body?.status === 'unrouted' && viaOrchestratorChat.posted.some((t) => /Junior takes work through Dev/.test(t)), viaOrchestratorChat);
    await setAccess(s.keys.owner, s.free, { ask_first: true });
    const before = (await approvals(s.free)).length;
    const askChat = await say('U_BEN', '@Free reconcile March please');
    const askChat2 = await say('U_BEN', '@Free any news?');
    const chatAsks = (await approvals(s.free)).slice(before);
    check('chat: ask first asks its managers once and tells the person; nothing reaches the agent', askChat.answer.body?.status === 'unrouted' && askChat2.answer.body?.status === 'unrouted'
      && chatAsks.length === 1 && chatAsks[0].action?.details?.entry === 'mention' && askChat.posted.some((t) => /asks its managers/.test(t)), [askChat, chatAsks]);
    if (chatAsks[0]) await approve(chatAsks[0].id, s.cara);
    const approvedChat = await say('U_BEN', '@Free and now?');
    check('chat: approved, the person\'s next message in that conversation goes through', ['pending', 'notified'].includes(approvedChat.answer.body?.status), approvedChat.answer.body);
    if (chatAsks[0]) await s.q("UPDATE pm.questions SET answered_at = now() - interval '25 hours' WHERE id = $1", [chatAsks[0].id]);
    const nextDay = await say('U_BEN', '@Free one more thing');
    const chatAsksLater = (await approvals(s.free)).slice(before);
    check('chat: a conversation\'s approval lasts a day; after that the managers are asked again', nextDay.answer.body?.status === 'unrouted' && chatAsksLater.length === 2, [nextDay.answer.body, chatAsksLater.length]);
    await setAccess(s.keys.owner, s.free, { ask_first: false });

    // ── Template defaults ──────────────────────────────────────────────
    const ownerAccess = await resolveMemberAccess(service, s.owner);
    const { caller, granter } = sessionCaller(s.owner, ownerAccess!);
    const builder = await hireAgent(service, caller, granter, { name: 'Bob Builder', template_key: 'builder', owner_ids: [s.cara] } as never, APP);
    const reporter = await hireAgent(service, caller, granter, { name: 'Rita Reporter', template_key: 'weekly-reporter' } as never, APP);
    const rows = async (id: string) => s.q<Loose>('SELECT kind, ref, effect FROM pm.agent_audience WHERE agent_id = $1', [id]);
    const builderRows = await rows(builder.agent.id);
    check('templates: a Builder starts usable by its managers only; a weekly reporter as before', builderRows.length === 1 && builderRows[0].kind === 'member' && builderRows[0].ref === s.cara
      && (await rows(reporter.agent.id)).length === 0, builderRows);

    // ── get_my_status: assistants off ──────────────────────────────────
    await s.q('UPDATE pm.business_settings SET assistants_enabled = false');
    const off = await v1(v1Status.GET, 'GET', '/api/v1/agents/me/status', {}, s.keys.pip);
    const company2 = await v1(v1Status.GET, 'GET', '/api/v1/agents/me/status', {}, s.keys.free);
    await s.q('UPDATE pm.business_settings SET assistants_enabled = true');
    check('status: a personal assistant reads assistants_off while assistants are off; a company agent does not', off.status === 200 && off.body?.data?.assistants_off === true
      && off.body.data.skip_reason === 'assistants_off' && off.body.data.can_start_work === false && company2.body?.data?.assistants_off === false && company2.body.data.can_start_work === true,
    [off.body, company2.body]);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`Agent hierarchy: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`Agent hierarchy: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
