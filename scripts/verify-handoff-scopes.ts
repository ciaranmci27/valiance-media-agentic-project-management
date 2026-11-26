/**
 * Handoff, context scopes and the agent registries
 * (20261125000100_handoff_scopes_registries.sql), end to end over the real
 * routes (v1 with keys, the MCP server, session routes as a signed-in
 * person), a fake PostgREST over PGlite with the full schema:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   it makes rows only for fleet profiles a member uses, backfills the
 *   template key, keeps existing context rows as project rows, and the
 *   previous release's writes still work. New functions and tables are the
 *   server's only; signed-in members never read other scopes' rows.
 * - Handoff: parent and root runs, the person carried down and never
 *   switched, a foreign parent refused, delegate_task making the assigned
 *   subtask linked to its run, the run tree, run webhooks with the chain.
 * - Context: every scope's visibility (an Owner never reads a person's
 *   memory; a personal agent reads it only while allowed), writes, delete
 *   of memory, search across scopes, the pack and brief carrying the right
 *   pinned entries within bounds.
 * - Registries: rows merge with code, a code key is refused, the four
 *   former core profiles resolve to the same tools, the template key on
 *   the agent, export and import.
 * - Chains of agents (20261125001600_delegation_chain.sql): the migration
 *   twice matches schema.sql and keeps older writes working; the database
 *   refuses a run deeper than 8 or under a looping chain; person to
 *   personal agent to company agent to builder to reviewer is one tree for
 *   that person; a whole task handed over; subtasks stay one level; a
 *   cycle, too deep a chain, a receiver off the project, a switched person
 *   and a personal agent not acting for its person are refused.
 *
 *   npm run -s test:handoff-scopes
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
import { CORE_AGENT_PROFILES } from '../src/lib/mcp/profiles';
import { CORE_AGENT_TEMPLATES } from '../src/lib/agent-templates';
import { DEFAULT_SWITCHES } from '../src/lib/assistant';
import type { AccessContext } from '../src/lib/access-control';

const MIGRATION = '20261125000100_handoff_scopes_registries.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- HANDOFF, CONTEXT SCOPES AND REGISTRIES (20261125000100_handoff_scopes_registries.sql)';
const NEW_FUNCTIONS = ['stamp_run_lineage', 'handle_project_context_scope', 'search_scoped_context', 'record_agent_template_key'];
const NEW_TABLES = ['task_delegations', 'mcp_profile_rows', 'agent_template_rows'];
const APP = 'https://pm.example.com';

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
  owner: { id: '00000000-0000-4000-8000-00000000e401', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000e402', email: 'ana@example.com' },
  ben: { id: '00000000-0000-4000-8000-00000000e403', email: 'ben@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-25T00:00:00Z' }));
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
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-25T00:00:00Z' };
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
  check('profiles: core keeps only generic', JSON.stringify(CORE_AGENT_PROFILES.map((p) => p.value)) === '["generic"]' && CORE_AGENT_PROFILES[0].tools === undefined);
  check('templates: no core template names a profile that left core', CORE_AGENT_TEMPLATES.every((t) => t.profile === undefined || t.profile === 'generic'));
  check('assistant: Remember things for me starts off', DEFAULT_SWITCHES.remember === false);
  check('no em dashes in the migration', !MIGRATION_SQL.includes('—'));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the section is there, after Connect AI', at > 0 && banner > 0 && SCHEMA_SQL.indexOf('-- CONNECT AI (20261125000000_connect_ai.sql)') < at);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Handoff: parent and root runs')).trim();
  check('schema.sql: the section mirrors the migration body', body.length > 2000 && SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => old.query(sql, params).then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  const agent = async (name: string, profile = 'generic') => (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, agent_profile) VALUES ($1, $2, 'agent', $3) RETURNING id", [name, `${name.toLowerCase()}@agents.example.com`, profile]))[0].id;
  const builder = await agent('Bob', 'builder');
  await agent('Rae', 'reviewer');
  const plain = await agent('Gen');
  const hired = await agent('Hal');
  await q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code, timestamp)
    VALUES ('POST', '/api/workspace/agents', 'team_member', $1, '{"template": "builder"}', 201, now() - interval '400 days'),
           ('POST', '/api/v1/agents/' || $1::text || '/template', 'team_member', $1, '{"template": "weekly-reporter"}', 200, now() - interval '10 days'),
           ('POST', '/api/v1/agents/' || $1::text || '/template', 'team_member', $1, '{"template": "inbox-triage"}', 422, now() - interval '1 day')`, [hired]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id"))[0].id;
  const entry = (await q<{ id: string; updated_at: string }>("INSERT INTO pm.project_context (project_id, category, content, updated_at) VALUES ($1, 'constraint', 'Never deploy on Fridays', now() - interval '3 days') RETURNING id, updated_at", [project]))[0];
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));

  const rows = await q<Loose>('SELECT value, tools, archived_at FROM pm.mcp_profile_rows ORDER BY value');
  check('profiles: only the fleet profiles members use become rows, with every tool', JSON.stringify(rows.map((r: Loose) => r.value)) === '["builder","reviewer"]'
    && rows.every((r: Loose) => r.tools === null && r.archived_at === null), rows);
  check('profiles: a fresh install gets no fleet rows', (await fresh.query<Loose>('SELECT count(*)::int AS n FROM pm.mcp_profile_rows')).rows[0].n === 0);
  const keys = await q<Loose>('SELECT id, agent_template_key FROM pm.team_members WHERE id = ANY($1)', [[hired, plain, builder]]);
  const keyOf = (id: string) => keys.find((k: Loose) => k.id === id)?.agent_template_key ?? null;
  check('template key: backfilled from the newest successful audit row; none stays null', keyOf(hired) === 'weekly-reporter' && keyOf(plain) === null && keyOf(builder) === null, keys);
  const ctx = (await q<Loose>('SELECT scope_type, scope_id, project_id, updated_at FROM pm.project_context WHERE id = $1', [entry.id]))[0];
  check('context: existing rows stay project rows, scope_id is their project, freshness kept', ctx.scope_type === 'project' && ctx.scope_id === project
    && new Date(ctx.updated_at).getTime() === new Date(entry.updated_at).getTime(), ctx);

  // What the previous release writes still works.
  await actAs(old, null);
  const oldCtx = (await q<Loose>("INSERT INTO pm.project_context (project_id, category, content) VALUES ($1, 'business_context', 'Old code entry') RETURNING scope_type, scope_id", [project]))[0];
  check('upgrade: a 2.0.29 context insert lands as a project row', oldCtx.scope_type === 'project' && oldCtx.scope_id === project, oldCtx);
  const oldRun = (await q<Loose>("INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, 'Old run') RETURNING id, parent_run_id, root_run_id", [plain]))[0];
  check('upgrade: a 2.0.29 run insert works, with no chain', oldRun.parent_run_id === null && oldRun.root_run_id === null);
  await q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code)
    VALUES ('POST', '/api/v1/agents/' || $1::text || '/template', 'team_member', $1::uuid, '{"template": "builder"}', 200)`, [plain]);
  check('template key: an audit row older code writes sets it on the agent', keyOf(plain) === null
    && (await q<Loose>('SELECT agent_template_key FROM pm.team_members WHERE id = $1', [plain]))[0].agent_template_key === 'builder');
  check('context: a project row without its project is refused, as is a workspace row naming an id',
    /scope_shape/.test(await fail("INSERT INTO pm.project_context (category, content) VALUES ('constraint', 'x')") ?? '')
    && /scope_shape/.test(await fail("INSERT INTO pm.project_context (scope_type, scope_id, category, content) VALUES ('workspace', $1, 'constraint', 'x')", [plain]) ?? ''));
  const ws = (await q<Loose>("INSERT INTO pm.project_context (scope_type, category, content) VALUES ('workspace', 'business_context', 'We sell bikes') RETURNING id"))[0].id;
  await q("UPDATE pm.project_context SET scope_type = 'member', scope_id = $1 WHERE id = $2", [plain, ws]);
  check('context: an entry never changes scope', (await q<Loose>('SELECT scope_type, scope_id FROM pm.project_context WHERE id = $1', [ws]))[0].scope_type === 'workspace');

  // Lineage in the database: the root, and the person carried down.
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const other = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Quin', 'quin@example.com', 'member') RETURNING id"))[0].id;
  const parent = (await q<Loose>("INSERT INTO pm.agent_runs (agent_id, principal_id) VALUES ($1, $2) RETURNING id", [plain, person]))[0].id;
  const child = (await q<Loose>('INSERT INTO pm.agent_runs (agent_id, parent_run_id) VALUES ($1, $2) RETURNING root_run_id, principal_id', [builder, parent]))[0];
  check('lineage: a child gets its root and its parent\'s person', child.root_run_id === parent && child.principal_id === person, child);
  check('lineage: a child for someone else is refused', /principal_carried/.test(await fail('INSERT INTO pm.agent_runs (agent_id, parent_run_id, principal_id) VALUES ($1, $2, $3)', [builder, parent, other]) ?? ''));
  await q("UPDATE pm.agent_runs SET parent_run_id = NULL, root_run_id = NULL WHERE parent_run_id = $1", [parent]);
  check('lineage: fixed once written', (await q<Loose>('SELECT count(*)::int AS n FROM pm.agent_runs WHERE parent_run_id = $1', [parent]))[0].n === 1);

  // Retention no longer keeps template rows (20261125000600); the agent keeps its key.
  await q('UPDATE pm.business_settings SET audit_retention_days = 30');
  await q('SELECT pm.purge_audit_log()');
  const left = await q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_id = $1 AND timestamp < now() - interval '100 days'", [hired]);
  check('retention: old template rows go; the template stays on the agent', left[0].n === 0 && keyOf(hired) === 'weekly-reporter', left);
  check('roles: people hold context.memory on the API by default; agents do not', (await q<Loose>("SELECT role FROM pm.role_permissions WHERE permission_key = 'context.memory' AND access_channel = 'api' ORDER BY role")).map((r: Loose) => r.role).join(',') === 'admin,member');
  await old.exec('RESET ROLE');

  const fnGrants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = ANY ($1)`, [NEW_FUNCTIONS]);
  check('grants: the new functions are not callable by anon or signed-in members; search is the server\'s', fnGrants.length === NEW_FUNCTIONS.length
    && fnGrants.every((g: Loose) => !g.anon && !g.auth) && fnGrants.find((g: Loose) => g.name === 'search_scoped_context')?.svc === true, fnGrants);
  const tableGrants = await q<Loose>(`SELECT t, bool_or(has_table_privilege(r, ('pm.' || t)::regclass, p)) AS any_access
    FROM unnest($1::text[]) t, unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p GROUP BY t`, [NEW_TABLES]);
  check('grants: browsers cannot read or write the new tables', tableGrants.length === NEW_TABLES.length && tableGrants.every((g: Loose) => !g.any_access), tableGrants);
  check('registries: rows are never deleted', /never permanently deleted/.test(await fail("DELETE FROM pm.mcp_profile_rows WHERE value = 'builder'") ?? ''));

  // A signed-in Owner reads project rows only, never a person's memory.
  const ownerLogin = '00000000-0000-4000-8000-0000000e4f01';
  await q("INSERT INTO auth.users (id, email) VALUES ($1, 'o@example.com')", [ownerLogin]);
  await q("INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ('Owner', 'o@example.com', 'owner', $1)", [ownerLogin]);
  await q("INSERT INTO pm.project_context (scope_type, scope_id, category, content) VALUES ('member', $1, 'business_context', 'Pat likes mornings')", [person]);
  await actAs(old, ownerLogin);
  const seen = await q<Loose>('SELECT scope_type FROM pm.project_context');
  check('row policy: a signed-in Owner sees project rows only', seen.length > 0 && seen.every((r: Loose) => r.scope_type === 'project'), seen);
  check('row policy: nor writes another scope', (await fail("INSERT INTO pm.project_context (scope_type, category, content) VALUES ('workspace', 'business_context', 'x')")) !== null);
  await old.exec('RESET ROLE');
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
  const ora = await member('Ora', 'agent');
  const spec = await member('Spec', 'agent');
  const zed = await member('Zed', 'agent');
  const pip = await member('Pip', 'agent', undefined, { delegate_of: ana, assistant_template: 'personal-assistant' });
  const cara = await member('Cara', 'member');
  const rex = await member('Rex', 'agent', undefined, { delegate_of: ben, assistant_template: 'personal-assistant' });
  const grant = async (memberId: string, permission: string) => q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow')", [memberId, permission]);
  await grant(ora, 'tasks.manage_all');
  await grant(ora, 'agents.manage');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const site = await project('Site', [ana, ora, spec, pip]);
  const secret = await project('Secret', [ben, zed]);
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Design', 'design') RETURNING id"))[0].id;
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3)', [group, ana, spec]);
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, ai_readiness) VALUES ($1, 'Launch the site', 'todo', 'ai_ready') RETURNING id", [site]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, ora]);
  const specTask = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, ai_readiness) VALUES ($1, 'Polish the footer', 'todo', 'ai_ready') RETURNING id", [site]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [specTask, spec]);
  // Ana writes her group's knowledge (project_context.manage in the app); Ben holds nothing.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'project_context.manage', 'app', 'allow')", [ana]);
  const key = async (memberId: string, scopes: string[]) => {
    const value = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(value).digest('hex'), memberId, scopes]);
    return value;
  };
  const AGENT = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write', 'project_context.read'];
  const keys = {
    owner: await key(owner, ['team.read', 'team.manage', 'project_context.read', 'project_context.manage', 'tasks.read', 'projects.read', 'api_keys.manage_all']),
    ana: await key(ana, ['tasks.read', 'project_context.read', 'project_context.manage', 'context.memory']),
    anaNarrow: await key(ana, ['tasks.read', 'project_context.read']),
    rex: await key(rex, AGENT),
    harness: await key(owner, ['assistants.provision', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'agent_activity.write']),
    ora: await key(ora, [...AGENT, 'tasks.manage_all', 'agents.manage']),
    spec: await key(spec, AGENT),
    zed: await key(zed, AGENT),
    pip: await key(pip, AGENT),
    noTeam: await key(ana, ['project_context.read']),
  };
  return { q, owner, ana, ben, cara, ora, spec, zed, pip, rex, site, secret, group, task, specTask, keys, key };
}

// ── Chains of agents: the migration ──────────────────────────────────────

const CHAIN_MIGRATION = '20261125001600_delegation_chain.sql';
const CHAIN_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', CHAIN_MIGRATION), 'utf8').replace(/\r\n/g, '\n');

async function chainMigrationChecks() {
  check('chain: no em dashes in the migration', !CHAIN_SQL.includes('—'));
  const section = CHAIN_SQL.trim();
  check('chain: schema.sql mirrors the migration', SCHEMA_SQL.includes(section));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.replace(section, '') });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => old.query(sql, params).then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@agents.example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id"))[0].id;
  const parentTask = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Parent') RETURNING id", [project]))[0].id;
  const sub = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, parent_task_id) VALUES ($1, 'Sub', $2) RETURNING id", [project, parentTask]))[0].id;
  const run = (await q<{ id: string }>('INSERT INTO pm.agent_runs (agent_id) VALUES ($1) RETURNING id', [agent]))[0].id;
  await q('INSERT INTO pm.task_delegations (task_id, run_id, delegated_by, delegated_to) VALUES ($1, $2, $3, $3)', [sub, run, agent]);
  await old.exec(CHAIN_SQL);
  await old.exec(CHAIN_SQL);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('chain: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const link = (await q<Loose>('SELECT mode, from_task_id FROM pm.task_delegations WHERE task_id = $1', [sub]))[0];
  check('chain: an earlier delegation reads as a subtask from its parent', link?.mode === 'subtask' && link.from_task_id === parentTask, link);
  const top = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Top') RETURNING id", [project]))[0].id;
  await q('INSERT INTO pm.task_delegations (task_id, run_id, delegated_by, delegated_to) VALUES ($1, $2, $3, $3) ON CONFLICT (task_id) DO UPDATE SET run_id = EXCLUDED.run_id', [top, run, agent]);
  check('chain: the previous release\'s upsert still works', (await q<Loose>('SELECT mode FROM pm.task_delegations WHERE task_id = $1', [top]))[0]?.mode === 'subtask');
  check('chain: an unknown mode is refused', /task_delegations_mode_check/.test(await fail("UPDATE pm.task_delegations SET mode = 'forward' WHERE task_id = $1", [top]) ?? ''));

  // Depth: eight hand-offs below the root, never nine.
  let at = run;
  for (let depth = 1; depth <= 8; depth++) {
    at = (await q<{ id: string }>('INSERT INTO pm.agent_runs (agent_id, parent_run_id) VALUES ($1, $2) RETURNING id', [agent, at]))[0].id;
  }
  check('chain: the database keeps a run at depth 8 on its root', (await q<Loose>('SELECT root_run_id FROM pm.agent_runs WHERE id = $1', [at]))[0]?.root_run_id === run);
  check('chain: the database refuses a run at depth 9', /agent_runs_chain_depth/.test(await fail('INSERT INTO pm.agent_runs (agent_id, parent_run_id) VALUES ($1, $2)', [agent, at]) ?? ''));

  // A loop can only come from links written around the guard; a run never goes under one.
  const a = (await q<{ id: string }>('INSERT INTO pm.agent_runs (agent_id) VALUES ($1) RETURNING id', [agent]))[0].id;
  const b = (await q<{ id: string }>('INSERT INTO pm.agent_runs (agent_id, parent_run_id) VALUES ($1, $2) RETURNING id', [agent, a]))[0].id;
  await old.exec('ALTER TABLE pm.agent_runs DISABLE TRIGGER stamp_run_lineage');
  await q('UPDATE pm.agent_runs SET parent_run_id = $1 WHERE id = $2', [b, a]);
  await old.exec('ALTER TABLE pm.agent_runs ENABLE TRIGGER stamp_run_lineage');
  check('chain: the database refuses a run under a looping chain', /agent_runs_no_cycle/.test(await fail('INSERT INTO pm.agent_runs (agent_id, parent_run_id) VALUES ($1, $2)', [agent, b]) ?? ''));
  check('chain: the chain guard stays the server\'s', (await q<Loose>("SELECT has_function_privilege('authenticated', 'pm.guard_run_chain()', 'EXECUTE') OR has_function_privilege('anon', 'pm.guard_run_chain()', 'EXECUTE') AS can"))[0]?.can === false);
  await fresh.close();
  await old.close();
}

// ── Chains of agents: end to end ─────────────────────────────────────────

interface ChainKit {
  s: Awaited<ReturnType<typeof seed>>;
  service: import('@supabase/supabase-js').SupabaseClient;
  start: (key: string, body?: Loose) => Promise<Answer>;
  tree: (key: string, id: string) => Promise<Answer>;
  delegate: (key: string, taskId: string, body: Loose) => Promise<Answer>;
  brief: (key: string, taskId: string) => Promise<Answer>;
  reason: (answer: Answer) => unknown;
  callTool: (key: string, name: string, args: Record<string, unknown>) => Promise<Loose>;
}

async function chainChecks({ s, service, start, tree, delegate, brief, reason, callTool }: ChainKit) {
  const { delegateTask } = await import('../src/lib/api/agent-handoff');
  const { resolveMemberAccess } = await import('../src/lib/api/access');
  const AGENT = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all', 'projects.read', 'agent_activity.write', 'project_context.read'];
  const agent = async (name: string) => (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, 'agent') RETURNING id", [name, `${name.toLowerCase()}@agents.example.com`]))[0].id;
  const alexa = await agent('Alexa');
  const jeff = await agent('Jeff');
  const rev = await agent('Rev');
  // Handing work to others takes tasks.manage_all, held by the person too: a chain never widens access.
  for (const m of [s.ana, s.pip, alexa, jeff, rev]) {
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'tasks.manage_all', 'api', 'allow')", [m]);
  }
  for (const m of [alexa, jeff, rev]) await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.site, m]);
  const ops = (await s.q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Ops') RETURNING id"))[0].id;
  for (const m of [s.ora, alexa]) await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [ops, m]);
  const keys = { pip: await s.key(s.pip, AGENT), alexa: await s.key(alexa, AGENT), jeff: await s.key(jeff, AGENT), rev: await s.key(rev, AGENT) };
  const pricing = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, ai_readiness) VALUES ($1, 'Fix the pricing page', 'todo', 'ai_ready') RETURNING id", [s.site]))[0].id;
  await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [pricing, s.pip]);
  const assignees = async (taskId: string) => (await s.q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1 ORDER BY member_id', [taskId])).map((r) => r.member_id);

  // 1. Ana asks Ashley (her personal agent, Pip here); Ashley hands the whole task to the company agent.
  const ashley = await start(keys.pip, { title: 'Fix pricing for Ana' });
  const ashleyRun: string = ashley.body?.data?.id;
  const handed = await delegate(keys.pip, pricing, { mode: 'assign', agent_id: alexa, run_id: ashleyRun, reassign: true });
  const handedLink = (await s.q<Loose>('SELECT run_id, delegated_by, delegated_to, mode, from_task_id FROM pm.task_delegations WHERE task_id = $1', [pricing]))[0];
  check('chain: a whole top-level task is handed over (mode assign), not a subtask', handed.status === 200 && handed.body?.data?.mode === 'assign' && handed.body.data.task_id === pricing
    && JSON.stringify(await assignees(pricing)) === JSON.stringify([alexa]) && handed.body.data.parent_task_id === null, [handed.status, handed.body]);
  check('chain: the task records the run that handed it over', handedLink?.run_id === ashleyRun && handedLink.delegated_by === s.pip && handedLink.delegated_to === alexa && handedLink.mode === 'assign', handedLink);
  const alexaBrief = await brief(keys.alexa, pricing);
  check('chain: the receiver\'s brief names the run and the mode', alexaBrief.body?.data?.delegated_from?.run_id === ashleyRun && alexaBrief.body.data.delegated_from.mode === 'assign', alexaBrief.body?.data?.delegated_from);

  // 2. The company agent continues the chain and hands the build to Jeff as a subtask.
  const alexaRun: string = (await start(keys.alexa, { task_id: pricing, parent_run_id: ashleyRun, title: 'Plan the pricing fix' })).body?.data?.id;
  const build = await delegate(keys.alexa, pricing, { agent_id: jeff, title: 'Build the new pricing table', run_id: alexaRun });
  const buildTask: string = build.body?.data?.task_id;
  check('chain: the company agent hands a subtask on from its own run', build.status === 201 && build.body?.data?.mode === 'subtask' && typeof buildTask === 'string', build.body);

  // 3. Jeff builds, then hands his subtask (the task itself) to the reviewer.
  const jeffRun: string = (await start(keys.jeff, { task_id: buildTask, parent_run_id: alexaRun, title: 'Build it' })).body?.data?.id;
  const nested = await delegate(keys.jeff, buildTask, { agent_id: rev, title: 'Review it', run_id: jeffRun });
  check('chain: subtasks stay one level (a subtask of a subtask is refused)', nested.status === 400 && /one level/.test(nested.body?.error?.message ?? ''), nested.body);
  const review = await delegate(keys.jeff, buildTask, { mode: 'assign', agent_id: rev, run_id: jeffRun });
  const subRow = (await s.q<Loose>('SELECT parent_task_id FROM pm.tasks WHERE id = $1', [buildTask]))[0];
  check('chain: a subtask can be handed over whole instead, and stays where it is', review.status === 200 && subRow?.parent_task_id === pricing
    && JSON.stringify(await assignees(buildTask)) === JSON.stringify([jeff, rev].sort()), [review.status, review.body, subRow]);

  // 4. The reviewer's run closes the chain: one root, Ana throughout, four levels.
  const revStart = await start(keys.rev, { task_id: buildTask, parent_run_id: jeffRun, title: 'Review the table' });
  const revRun: string = revStart.body?.data?.id;
  const t = await tree(keys.rev, revRun);
  const nodes: Loose[] = t.body?.data?.runs ?? [];
  const depthOf = (id: string) => nodes.find((n) => n.id === id)?.depth;
  check('chain: person, personal agent, company agent, builder, reviewer: one root, one person, depth 4', t.status === 200 && t.body.data.root_run_id === ashleyRun
    && t.body.data.principal_id === s.ana && t.body.data.levels === 4 && nodes.length === 4 && nodes.every((n) => n.principal_id === s.ana)
    && depthOf(ashleyRun) === 0 && depthOf(alexaRun) === 1 && depthOf(jeffRun) === 2 && depthOf(revRun) === 3 && revStart.body?.data?.root_run_id === ashleyRun, t.body);
  check('chain: the tree spans tasks and shows each hand-off with its mode', nodes.find((n) => n.id === alexaRun)?.task_id === pricing && nodes.find((n) => n.id === revRun)?.task_id === buildTask
    && (nodes.find((n) => n.id === ashleyRun)?.delegated ?? []).some((d: Loose) => d.task_id === pricing && d.mode === 'assign')
    && (nodes.find((n) => n.id === jeffRun)?.delegated ?? []).some((d: Loose) => d.task_id === buildTask && d.delegated_to === rev && d.mode === 'assign'), nodes);
  const viaMcp = await callTool(keys.rev, 'get_run_tree', { run_id: revRun });
  check('chain: get_run_tree over MCP answers the same chain', viaMcp?.ok === true && viaMcp.data?.levels === 4 && viaMcp.data?.principal_id === s.ana, viaMcp);

  // Cycles: never back to an agent above, nor to yourself.
  const back = await delegate(keys.alexa, pricing, { mode: 'assign', agent_id: s.pip, run_id: alexaRun });
  const self = await delegate(keys.jeff, buildTask, { mode: 'assign', agent_id: jeff, run_id: jeffRun });
  check('chain: handing work back up the chain is refused (409 delegation_cycle)', back.status === 409 && reason(back) === 'delegation_cycle'
    && self.status === 409 && reason(self) === 'delegation_cycle', [back.body, self.body]);

  // The receiver must reach the project; a chain for Ana stays where Ana reaches.
  const offProject = await delegate(keys.alexa, pricing, { agent_id: s.zed, title: 'Audit it', run_id: alexaRun });
  check('chain: a receiver without access to the project is refused (422)', offProject.status === 422 && reason(offProject) === 'receiver_no_project_access', offProject.body);
  const opsTask = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Rotate the logs', 'todo') RETURNING id", [ops]))[0].id;
  await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [opsTask, s.ora]);
  const outside = await start(keys.alexa, { task_id: opsTask, parent_run_id: alexaRun });
  const ownWork = await start(keys.alexa, { task_id: opsTask });
  check('chain: a run in Ana\'s chain stays where Ana reaches; the same run of its own is fine', outside.status === 404 && ownWork.status === 201, [outside.status, outside.body, ownWork.status]);
  const oraForAna: string = (await start(s.keys.ora, { parent_run_id: ashleyRun, title: 'Help with pricing' })).body?.data?.id;
  const widened = await delegate(s.keys.ora, opsTask, { agent_id: alexa, title: 'Check the rotation', run_id: oraForAna });
  const unchained = await delegate(s.keys.ora, opsTask, { agent_id: alexa, title: 'Check the rotation' });
  check('chain: a hand-off in Ana\'s chain never reaches a project she cannot; outside the chain it can', widened.status === 404 && unchained.status === 201, [widened.status, widened.body, unchained.status]);

  // The person is never switched.
  const otherPerson = await delegate(keys.alexa, pricing, { mode: 'assign', agent_id: s.rex, run_id: alexaRun });
  check('chain: handing Ana\'s work to someone else\'s personal agent is refused (403 principal_mismatch)', otherPerson.status === 403 && reason(otherPerson) === 'principal_mismatch', otherPerson.body);
  const toPersonal = await delegate(keys.pip, pricing, { mode: 'assign', agent_id: s.rex });
  check('chain: a personal agent hands work only to company agents', toPersonal.status === 403 && reason(toPersonal) === 'receiver_is_personal_agent', toPersonal.body);

  // A personal agent not acting for its person hands nothing on.
  const pipAccess = await resolveMemberAccess(service, s.pip);
  const bare = { ...pipAccess! };
  delete bare.principal_id;
  const notActing = await delegateTask({ supabase: service, apiKeyId: 'no-key', teamMemberId: s.pip, access: bare, scopes: AGENT }, pricing, { agent_id: alexa, mode: 'assign', run_id: ashleyRun })
    .then(() => null, (error: Loose) => error);
  check('chain: a personal agent delegating without acting for its person is refused (403)', notActing?.statusCode === 403 && notActing.details?.reason === 'personal_agent_not_acting', notActing?.message ?? notActing);

  // Depth: 8 hand-offs below the root, never 9, for a run or a delegation.
  let deepest: string = (await start(s.keys.ora, { title: 'Depth 0' })).body?.data?.id;
  for (let depth = 1; depth <= 8; depth++) deepest = (await start(s.keys.ora, { parent_run_id: deepest, title: `Depth ${depth}` })).body?.data?.id;
  const deepTree = await tree(s.keys.ora, deepest);
  const tooDeepRun = await start(s.keys.ora, { parent_run_id: deepest });
  const tooDeepHand = await delegate(s.keys.ora, s.task, { agent_id: s.spec, title: 'Too deep', run_id: deepest });
  check('chain: a chain 8 deep is fine; a run or hand-off below it is refused (409 chain_too_deep)', deepTree.body?.data?.levels === 9 && deepTree.body.data.max_depth === 8
    && tooDeepRun.status === 409 && reason(tooDeepRun) === 'chain_too_deep' && tooDeepHand.status === 409 && reason(tooDeepHand) === 'chain_too_deep',
  [deepTree.body?.data?.levels, tooDeepRun.body, tooDeepHand.body]);

  // Mode assign takes no subtask fields; a subtask needs its title.
  const mixed = await delegate(keys.alexa, pricing, { mode: 'assign', agent_id: jeff, title: 'x' });
  const untitled = await delegate(keys.alexa, pricing, { agent_id: jeff });
  check('chain: mode assign refuses subtask fields; a subtask needs a title', [400, 422].includes(mixed.status) && [400, 422].includes(untitled.status), [mixed.status, mixed.body, untitled.status]);
}

async function main() {
  pureChecks();
  await migrationChecks();
  await chainMigrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: APP,
  });
  installSession(server.url);
  try {
    const v1Runs = await import('../src/app/api/v1/agents/runs/route');
    const v1RunTree = await import('../src/app/api/v1/agents/runs/[id]/tree/route');
    const v1Delegate = await import('../src/app/api/v1/tasks/[id]/delegate/route');
    const v1Brief = await import('../src/app/api/v1/tasks/[id]/brief/route');
    const v1Context = await import('../src/app/api/v1/context/route');
    const v1ContextSearch = await import('../src/app/api/v1/context/search/route');
    const v1ContextEntry = await import('../src/app/api/v1/context/[entryId]/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const v1AgentContext = await import('../src/app/api/v1/agents/[id]/context/route');
    const v1Profiles = await import('../src/app/api/v1/agent-profiles/route');
    const v1Profile = await import('../src/app/api/v1/agent-profiles/[value]/route');
    const v1Templates = await import('../src/app/api/v1/agent-templates/route');
    const v1Template = await import('../src/app/api/v1/agent-templates/[key]/route');
    const v1Apply = await import('../src/app/api/v1/agents/[id]/template/route');
    const v1Export = await import('../src/app/api/v1/agent-registries/export/route');
    const v1Import = await import('../src/app/api/v1/agent-registries/import/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const scopeRoute = await import('../src/app/api/workspace/context/[scope]/route');
    const scopeEntryRoute = await import('../src/app/api/workspace/context/[scope]/[entryId]/route');
    const memberRoute = await import('../src/app/api/workspace/team-members/[id]/route');
    const { toolsFor } = await import('../src/lib/mcp/visibility');
    const { resolveAgentProfile } = await import('../src/lib/api/agent-registries');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { SCOPED_PINNED_LIMITS, scopeAccess } = await import('../src/lib/api/context-scopes');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { CONNECT_SCOPES, canOfferMemory, connectAbilities, connectScopesFor } = await import('../src/lib/connect-ai');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text); } catch { body = null; }
      return { status: response.status, body, text };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
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
    const toolNames = async (key: string) => ((await mcp(key, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).body?.result?.tools ?? []).map((t: Loose) => t.name as string);
    const callTool = async (key: string, name: string, args: Record<string, unknown>) =>
      (await mcp(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).body?.result?.structuredContent as Loose;
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const start = (key: string, body: Loose = {}) => v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, key, body);
    const tree = (key: string, id: string) => v1(v1RunTree.GET, 'GET', `/api/v1/agents/runs/${id}/tree`, { id }, key);
    const delegate = (key: string, taskId: string, body: Loose) => v1(v1Delegate.POST, 'POST', `/api/v1/tasks/${taskId}/delegate`, { id: taskId }, key, body);
    const brief = (key: string, taskId: string) => v1(v1Brief.GET, 'GET', `/api/v1/tasks/${taskId}/brief`, { id: taskId }, key);
    const ctxGet = (key: string, query: string) => v1(v1Context.GET, 'GET', `/api/v1/context?${query}`, {}, key);
    const ctxAdd = (key: string, body: Loose) => v1(v1Context.POST, 'POST', '/api/v1/context', {}, key, body);
    const ctxSearch = (key: string, query: string) => v1(v1ContextSearch.GET, 'GET', `/api/v1/context/search?${query}`, {}, key);
    const scopeGet = (scope: string, id: string | null) => session(scopeRoute.GET, 'GET', `/api/workspace/context/${scope}${id ? `?scope_id=${id}` : ''}`, { scope });
    const scopeAdd = (scope: string, id: string | null, body: Loose) => session(scopeRoute.POST, 'POST', `/api/workspace/context/${scope}${id ? `?scope_id=${id}` : ''}`, { scope }, body);
    const myPack = async (key: string) => (await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, key)).body?.data?.pack;

    // ── Handoff ────────────────────────────────────────────────────────
    await s.q("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Runs', 'https://hooks.example.test/r', 'whsec_x', '{run.started}')");
    const r1 = await start(s.keys.ora, { task_id: s.task, title: 'Plan the launch' });
    const rootId: string = r1.body?.data?.id;
    check('runs: a run of its own carries no chain (as before)', r1.status === 201 && !('parent_run_id' in (r1.body?.data ?? {})) && !('root_run_id' in (r1.body?.data ?? {})), r1.body);

    const d1 = await delegate(s.keys.ora, s.task, { agent_id: s.spec, title: 'Write the launch copy', run_id: rootId });
    const subtask: string = d1.body?.data?.task_id;
    const subRow = (await s.q<Loose>('SELECT t.parent_task_id, t.ai_readiness, array_agg(a.member_id) AS assignees FROM pm.tasks t JOIN pm.task_assignees a ON a.task_id = t.id WHERE t.id = $1 GROUP BY t.id', [subtask]))[0];
    const link = (await s.q<Loose>('SELECT run_id, delegated_by, delegated_to FROM pm.task_delegations WHERE task_id = $1', [subtask]))[0];
    check('delegate: a subtask of the task, assigned to the specialist, ai_ready, its id answered', d1.status === 201 && subRow?.parent_task_id === s.task
      && JSON.stringify(subRow?.assignees) === JSON.stringify([s.spec]) && subRow?.ai_readiness === 'ai_ready' && d1.body?.data?.delegated_to === s.spec, [d1.status, d1.body, subRow]);
    check('delegate: linked to the run that delegated it', link?.run_id === rootId && link.delegated_by === s.ora && link.delegated_to === s.spec, link);
    const notAgent = await delegate(s.keys.ora, s.task, { agent_id: s.ana, title: 'x' });
    const noManageAll = await delegate(s.keys.spec, s.specTask, { agent_id: s.ora, title: 'x' });
    const foreignRun = await delegate(s.keys.spec, s.specTask, { agent_id: s.ora, title: 'x', run_id: (await start(s.keys.zed, {})).body?.data?.id });
    check('delegate: only to an agent; assigning others needs tasks.manage_all; only from a run the key sees', notAgent.status === 422 && reason(notAgent) === 'not_an_agent'
      && noManageAll.status === 403 && foreignRun.status === 404, [notAgent.body, noManageAll.status, foreignRun.status]);

    const specBrief = await brief(s.keys.spec, subtask);
    check('brief: a delegated subtask names the run that handed it over', specBrief.body?.data?.delegated_from?.run_id === rootId && specBrief.body.data.delegated_from.agent_name === 'Ora', specBrief.body?.data?.delegated_from);
    const parentBrief = await brief(s.keys.ora, s.task);
    check('brief: a task nobody delegated has no delegated_from', parentBrief.status === 200 && !('delegated_from' in parentBrief.body.data));

    const r2 = await start(s.keys.spec, { task_id: subtask, parent_run_id: rootId, title: 'Draft copy' });
    const childId: string = r2.body?.data?.id;
    check('runs: a specialist starts a child of the run that delegated to it; root derived', r2.status === 201 && r2.body.data.parent_run_id === rootId && r2.body.data.root_run_id === rootId, r2.body);
    const r3 = await start(s.keys.spec, { parent_run_id: childId, title: 'Check tone' });
    check('runs: a grandchild keeps the root', r3.status === 201 && r3.body.data.parent_run_id === childId && r3.body.data.root_run_id === rootId, r3.body);
    const foreign = await start(s.keys.zed, { parent_run_id: rootId });
    check('runs: a parent the key cannot see is refused (404)', foreign.status === 404, foreign.body);
    const event = (await s.q<Loose>("SELECT payload::text AS p FROM pm.webhook_events WHERE event_type = 'run.started' AND resource_id = $1", [childId]))[0];
    check('webhooks: run.started carries parent_run_id and root_run_id', !!event && event.p.includes(`"parent_run_id": "${rootId}"`) && event.p.includes(`"root_run_id": "${rootId}"`), event);
    const rootEvent = (await s.q<Loose>("SELECT payload::text AS p FROM pm.webhook_events WHERE event_type = 'run.started' AND resource_id = $1", [rootId]))[0];
    check('webhooks: a run with no parent reads as before', !!rootEvent && !rootEvent.p.includes('parent_run_id'), rootEvent);

    // The person is carried down and never switched.
    const pipRun = await start(s.keys.pip, { title: 'For Ana' });
    check('runs: a personal agent\'s run is made for its person', pipRun.status === 201 && pipRun.body.data.principal_id === s.ana, pipRun.body);
    const carried = await start(s.keys.ora, { parent_run_id: pipRun.body.data.id, title: 'Help Pip' });
    check('runs: a child of a run made for someone is made for them too', carried.status === 201 && carried.body.data.principal_id === s.ana && carried.body.data.root_run_id === pipRun.body.data.id, carried.body);
    const toPersonal = await delegate(s.keys.ora, s.task, { agent_id: s.pip, title: 'Book the venue', run_id: rootId });
    check('delegate: a personal agent never receives work for someone else (403 principal_mismatch)', toPersonal.status === 403 && reason(toPersonal) === 'principal_mismatch', toPersonal.body);
    // A link written some other way (an older release) still never lets the child switch person.
    const venue = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Book the venue', 'todo') RETURNING id", [s.site]))[0].id;
    await s.q('INSERT INTO pm.task_delegations (task_id, run_id, delegated_by, delegated_to) VALUES ($1, $2, $3, $4)', [venue, rootId, s.ora, s.pip]);
    const switched = await start(s.keys.pip, { parent_run_id: rootId });
    check('runs: a child cannot switch to another person (403 principal_mismatch)', switched.status === 403 && reason(switched) === 'principal_mismatch', switched.body);

    const t = await tree(s.keys.spec, r3.body.data.id);
    const nodes: Loose[] = t.body?.data?.runs ?? [];
    const node = (id: string) => nodes.find((n) => n.id === id);
    check('tree: from any run, every run from the root with depth', t.status === 200 && t.body.data.root_run_id === rootId && nodes.length === 3
      && node(rootId)?.depth === 0 && node(childId)?.depth === 1 && node(r3.body.data.id)?.depth === 2, t.body);
    check('tree: another agent\'s run shows its place, not its summary or trace', node(rootId)?.visible === false && node(rootId)?.agent_name === 'Ora' && node(rootId)?.external_url === null
      && node(childId)?.visible === true, nodes);
    check('tree: the subtasks each run delegated', (node(rootId)?.delegated ?? []).some((d: Loose) => d.task_id === subtask && d.delegated_to === s.spec), node(rootId));
    check('tree: a key with no run in it cannot read it', (await tree(s.keys.zed, rootId)).status === 404);
    check('tree: agents.manage reads it all', (await tree(s.keys.ora, childId)).body?.data?.runs?.every((n: Loose) => n.visible === true));

    const viaMcp = await callTool(s.keys.ora, 'delegate_task', { task_id: s.task, agent_id: s.spec, title: 'Proofread', run_id: rootId, idempotency_key: randomUUID() });
    check('mcp: delegate_task makes the subtask and answers its id', viaMcp?.ok === true && typeof viaMcp.data?.task_id === 'string', viaMcp);
    const treeTool = await callTool(s.keys.spec, 'get_run_tree', { run_id: childId });
    check('mcp: get_run_tree', treeTool?.ok === true && treeTool.data?.root_run_id === rootId, treeTool);
    const specTools = await toolNames(s.keys.spec);
    check('mcp: delegate_task is listed only for a key that may assign others', !specTools.includes('delegate_task') && (await toolNames(s.keys.ora)).includes('delegate_task')
      && specTools.includes('search_context') && specTools.includes('add_context') && specTools.includes('get_run_tree'), specTools);

    // ── Context at every level ─────────────────────────────────────────
    as(LOGINS.owner);
    const wsEntry = await scopeAdd('workspace', null, { section: 'overview', content: 'We sell custom bikes, launch week is in March.', pinned: true });
    check('workspace: an Owner adds company knowledge', wsEntry.status === 201 && wsEntry.body?.data?.scope_type === 'workspace', wsEntry.body);
    as(LOGINS.ana);
    const anaWs = await scopeAdd('workspace', null, { section: 'overview', content: 'x' });
    const anaWsRead = await scopeGet('workspace', null);
    check('workspace: every member reads it; a member without the right cannot write it', anaWs.status === 403 && anaWsRead.status === 200
      && anaWsRead.body.data.sections.some((sec: Loose) => sec.entries.some((e: Loose) => e.id === wsEntry.body.data.id)) && anaWsRead.body.data.can_edit === false, [anaWs.status, anaWsRead.body]);
    const groupEntry = await scopeAdd('group', s.group, { section: 'rules', content: 'Design reviews happen on Tuesdays before launch.', pinned: true });
    check('group: a member writes its knowledge', groupEntry.status === 201, groupEntry.body);
    as(LOGINS.ben);
    check('group: someone outside it cannot read it', (await scopeGet('group', s.group)).status === 403);
    check('workspace: a member whose role holds no context permission still reads company knowledge', (await scopeGet('workspace', null)).status === 200);
    as(LOGINS.owner);
    check('group: whoever manages groups reads it', (await scopeGet('group', s.group)).status === 200);
    const agentNote = await scopeAdd('agent', s.spec, { section: 'overview', content: 'Keep copy under 80 words for the launch.', pinned: true });
    check('agent: whoever manages the agent adds its notes', agentNote.status === 201, agentNote.body);
    const ownNote = await ctxAdd(s.keys.spec, { scope_type: 'agent', scope_id: s.spec, content: 'Ana prefers British spelling.', section: 'history' });
    const othersNote = await ctxAdd(s.keys.spec, { scope_type: 'agent', scope_id: s.ora, content: 'x' });
    check('agent: an agent keeps its own notes with only project_context.read; not another agent\'s', ownNote.status === 201 && ownNote.body.data.source === 'agent' && othersNote.status === 403, [ownNote.body, othersNote.status]);
    check('agent: an agent that does not manage it cannot read it', (await ctxGet(s.keys.zed, `scope_type=agent&scope_id=${s.spec}`)).status === 403);

    as(LOGINS.ana);
    const memory = await scopeAdd('member', s.ana, { section: 'overview', content: 'I take Fridays off during launch month.', pinned: true });
    check('member: a person writes their own memory', memory.status === 201 && memory.body.data.scope_type === 'member', memory.body);
    as(LOGINS.owner);
    const ownerSession = await scopeGet('member', s.ana);
    const ownerKey = await ctxGet(s.keys.owner, `scope_type=member&scope_id=${s.ana}`);
    const ownerSearch = await ctxSearch(s.keys.owner, 'q=Fridays');
    check('member: an Owner never reads a person\'s memory (session, key or search)', ownerSession.status === 403 && ownerKey.status === 403 && reason(ownerKey) === 'personal_memory'
      && ownerSearch.status === 200 && !ownerSearch.body.data.some((e: Loose) => e.scope_type === 'member'), [ownerSession.status, ownerKey.body, ownerSearch.body]);
    check('member: nor changes or deletes it', (await v1(v1ContextEntry.DELETE, 'DELETE', `/api/v1/context/${memory.body.data.id}`, { entryId: memory.body.data.id }, s.keys.owner)).status === 404);
    const pipOff = await ctxGet(s.keys.pip, `scope_type=member&scope_id=${s.ana}`);
    const pipOffAdd = await ctxAdd(s.keys.pip, { scope_type: 'member', scope_id: s.ana, content: 'x' });
    check('member: a personal agent reads and writes its person\'s memory only while allowed', pipOff.status === 403 && pipOffAdd.status === 403, [pipOff.status, pipOffAdd.status]);
    // An Owner turning it on for her counts for nothing: only the person's own switch does.
    await s.q(`INSERT INTO pm.assistant_preferences (agent_id, switches, updated_by) VALUES ($1, '{"remember": true}', $2)`, [s.pip, s.owner]);
    check('member: a switch someone else turned on does not let it remember', (await ctxGet(s.keys.pip, `scope_type=member&scope_id=${s.ana}`)).status === 403);
    await s.q('UPDATE pm.assistant_preferences SET updated_by = $1 WHERE agent_id = $2', [s.ana, s.pip]);
    const pipOn = await ctxGet(s.keys.pip, `scope_type=member&scope_id=${s.ana}`);
    const pipAdd = await ctxAdd(s.keys.pip, { scope_type: 'member', scope_id: s.ana, content: 'Ana wants launch updates by 9am.', pinned: true, idempotency_key: undefined });
    check('member: once allowed, it reads and adds to that memory', pipOn.status === 200 && pipOn.body.data.sections.some((sec: Loose) => sec.entries.some((e: Loose) => e.id === memory.body.data.id))
      && pipAdd.status === 201, [pipOn.status, pipAdd.body]);
    check('member: never another person\'s; never another agent', (await ctxGet(s.keys.pip, `scope_type=member&scope_id=${s.ben}`)).status === 403
      && (await ctxGet(s.keys.spec, `scope_type=member&scope_id=${s.ana}`)).status === 403);

    const narrow = await ctxGet(s.keys.anaNarrow, `scope_type=member&scope_id=${s.ana}`);
    const narrowSearch = await ctxSearch(s.keys.anaNarrow, 'q=Fridays&scope_types=member');
    check('memory: a person\'s own key without context.memory is refused it, and search leaves it out', narrow.status === 403 && reason(narrow) === 'personal_memory'
      && narrowSearch.status === 200 && narrowSearch.body.data.length === 0, [narrow.body, narrowSearch.body]);
    check('memory: with context.memory her key reads it', (await ctxGet(s.keys.ana, `scope_type=member&scope_id=${s.ana}`)).status === 200);
    const anaAccess = (await resolveMemberAccess(service, s.ana))!;
    const connectionCaller = (withMemory: boolean) => ({ memberId: s.ana, access: anaAccess, scopes: connectScopesFor(anaAccess, { withMemory }) as string[] });
    check('memory: a default connection holds no memory scope and is refused it; ticking the extra adds it', !CONNECT_SCOPES.includes('context.memory')
      && !connectScopesFor(anaAccess).includes('context.memory') && connectScopesFor(anaAccess, { withMemory: true }).includes('context.memory') && canOfferMemory(anaAccess)
      && (await scopeAccess(service, connectionCaller(false), { scope_type: 'member', scope_id: s.ana })).read === false
      && (await scopeAccess(service, connectionCaller(true), { scope_type: 'member', scope_id: s.ana })).read === true
      && (await scopeAccess(service, connectionCaller(false), { scope_type: 'workspace', scope_id: null })).read === true);
    check('memory: the consent screen says the extra plainly', connectAbilities(['context.memory']).includes('Read and add to what your assistant remembers about you'));

    // A re-bound personal agent never brings "remember" to its new person.
    await s.q(`INSERT INTO pm.assistant_preferences (agent_id, switches, updated_by) VALUES ($1, '{"remember": true}', $2)`, [s.rex, s.ben]);
    as(LOGINS.ben);
    await scopeAdd('member', s.ben, { section: 'overview', content: 'Ben likes short updates.' });
    check('rebind: before, Rex reads its person\'s memory', (await ctxGet(s.keys.rex, `scope_type=member&scope_id=${s.ben}`)).status === 200);
    await s.q("INSERT INTO pm.project_context (scope_type, scope_id, category, content) VALUES ('member', $1, 'business_context', 'Cara is moving house in April')", [s.cara]);
    as(LOGINS.owner);
    const bindRoute = await import('../src/app/api/workspace/assistants/bind/route');
    const rebound = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.rex, person_id: s.cara });
    const prefsAfter = await s.q<Loose>('SELECT count(*)::int AS n FROM pm.assistant_preferences WHERE agent_id = $1', [s.rex]);
    const rexKey = await s.key(s.rex, ['tasks.read', 'projects.read', 'project_context.read']);
    const afterRebind = await ctxGet(rexKey, `scope_type=member&scope_id=${s.cara}`);
    check('rebind: the settings reset, and Rex cannot read its new person\'s memory', rebound.status === 200 && prefsAfter[0].n === 0 && afterRebind.status === 403, [rebound.status, rebound.body, prefsAfter, afterRebind.status]);
    // Even a row left over from the old person counts for nothing.
    await s.q(`INSERT INTO pm.assistant_preferences (agent_id, switches, updated_by) VALUES ($1, '{"remember": true}', $2)
      ON CONFLICT (agent_id) DO UPDATE SET switches = EXCLUDED.switches, updated_by = EXCLUDED.updated_by`, [s.rex, s.ben]);
    check('rebind: a switch the old person set never counts for the new one', (await ctxGet(rexKey, `scope_type=member&scope_id=${s.cara}`)).status === 403
      && !((await myPack(rexKey))?.scoped_context ?? []).some((sc: Loose) => sc.scope_type === 'member'));

    // A one-scope search finds its matches however many better ones other groups hold.
    for (let g = 0; g < 3; g++) {
      const other = (await s.q<{ id: string }>('INSERT INTO pm.groups (name, slug) VALUES ($1, $2) RETURNING id', [`Other ${g}`, `other-${g}`]))[0].id;
      for (let i = 0; i < 20; i++) await s.q("INSERT INTO pm.project_context (scope_type, scope_id, category, section, content) VALUES ('group', $1, 'business_context', 'overview', 'Launch launch launch: launch plan, launch day, launch party')", [other]);
    }
    const searchRoute = await import('../src/app/api/workspace/context/[scope]/search/route');
    const designSearch = await session(searchRoute.GET, 'GET', `/api/workspace/context/group/search?scope_id=${s.group}&q=launch`, { scope: 'group' });
    check('search: one scope\'s search finds its own matches past 60 better hits elsewhere', designSearch.status === 200 && designSearch.body.data.entries.length === 1
      && designSearch.body.data.entries[0].scope_id === s.group, designSearch.body);
    as(LOGINS.ben);
    check('search: a scope the reader cannot see is refused', (await session(searchRoute.GET, 'GET', `/api/workspace/context/group/search?scope_id=${s.group}&q=launch`, { scope: 'group' })).status === 403);
    as(LOGINS.owner);

    const specSearch = await ctxSearch(s.keys.spec, 'q=launch');
    const types = new Set((specSearch.body?.data ?? []).map((e: Loose) => e.scope_type));
    check('search: across the scopes the caller reads (workspace, its group, its notes), never a memory', specSearch.status === 200 && types.has('workspace') && types.has('group') && types.has('agent') && !types.has('member'), specSearch.body);
    const anaSearch = await v1(v1ContextSearch.GET, 'GET', '/api/v1/context/search?q=launch&scope_types=member', {}, s.keys.ana);
    check('search: a person finds their own memory; scope_types narrows it', anaSearch.status === 200 && anaSearch.body.data.length >= 1 && anaSearch.body.data.every((e: Loose) => e.scope_type === 'member'), anaSearch.body);
    const zedSearch = await ctxSearch(s.keys.zed, 'q=launch');
    check('search: an agent outside the group and project sees only the workspace', zedSearch.status === 200 && zedSearch.body.data.every((e: Loose) => e.scope_type === 'workspace'), zedSearch.body);

    // The pack and the brief carry the right pinned entries.
    const specPack = await myPack(s.keys.spec);
    const specScopes = (specPack?.scoped_context ?? []).map((sc: Loose) => sc.scope_type);
    check('pack: workspace, the agent\'s groups and its own pinned notes; no memory', JSON.stringify(specScopes) === '["workspace","group","agent"]'
      && specPack.scoped_context.find((sc: Loose) => sc.scope_type === 'group').name === 'Design', specPack?.scoped_context);
    const pipPack = await myPack(s.keys.pip);
    check('pack: a personal agent allowed to remember carries its person\'s pinned memory', (pipPack?.scoped_context ?? []).some((sc: Loose) => sc.scope_type === 'member' && sc.entries.length === 2), pipPack?.scoped_context);
    const ownerReadsPip = await v1(v1AgentContext.GET, 'GET', `/api/v1/agents/${s.pip}/context?format=pack`, { id: s.pip }, s.keys.owner);
    check('pack: an Owner reading the personal agent\'s pack never sees that memory', ownerReadsPip.status === 200 && !(ownerReadsPip.body.data.pack.scoped_context ?? []).some((sc: Loose) => sc.scope_type === 'member'), ownerReadsPip.body?.data?.pack?.scoped_context);
    const zedPack = await myPack(s.keys.zed);
    check('pack: an agent with nothing pinned beyond the workspace gets only that', JSON.stringify((zedPack?.scoped_context ?? []).map((sc: Loose) => sc.scope_type)) === '["workspace"]', zedPack?.scoped_context);
    const specSubBrief = await brief(s.keys.spec, subtask);
    check('brief: scoped_context beside the project\'s own entries', JSON.stringify((specSubBrief.body?.data?.scoped_context ?? []).map((sc: Loose) => sc.scope_type)) === '["workspace","group","agent"]'
      && specSubBrief.body.data.project_context !== undefined, specSubBrief.body?.data?.scoped_context);
    for (let i = 0; i < 30; i++) await s.q("INSERT INTO pm.project_context (scope_type, category, section, content, pinned) VALUES ('workspace', 'business_context', 'overview', $1, true)", [`Pinned fact ${i} ${'x'.repeat(700)}`]);
    const bounded = await myPack(s.keys.spec);
    const wsScope = (bounded?.scoped_context ?? []).find((sc: Loose) => sc.scope_type === 'workspace');
    const total = (bounded?.scoped_context ?? []).reduce((n: number, sc: Loose) => n + sc.entries.length, 0);
    check('bounds: at most perScope pinned per scope and total in all, each entry cut, the rest counted', wsScope?.entries.length === SCOPED_PINNED_LIMITS.perScope && wsScope.more > 0
      && total <= SCOPED_PINNED_LIMITS.total && wsScope.entries.every((e: Loose) => e.content.length <= SCOPED_PINNED_LIMITS.entry + 1), { len: wsScope?.entries.length, more: wsScope?.more, total });
    check('bounds: the pack stays within its limit', JSON.stringify(bounded).length <= 24_000);

    as(LOGINS.ana);
    const del = await session(scopeEntryRoute.DELETE, 'DELETE', `/api/workspace/context/member/${memory.body.data.id}`, { scope: 'member', entryId: memory.body.data.id });
    check('member: the person deletes from their memory for good', del.status === 200 && del.body.data.deleted === true
      && (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.project_context WHERE id = $1', [memory.body.data.id]))[0].n === 0, del.body);
    const archive = await v1(v1ContextEntry.DELETE, 'DELETE', `/api/v1/context/${ownNote.body.data.id}`, { entryId: ownNote.body.data.id }, s.keys.spec);
    check('agent: removing a note archives it', archive.status === 200 && archive.body.data.archived === true
      && (await s.q<Loose>('SELECT is_active FROM pm.project_context WHERE id = $1', [ownNote.body.data.id]))[0].is_active === false, archive.body);

    // ── Registries ─────────────────────────────────────────────────────
    const profile = await v1(v1Profiles.POST, 'POST', '/api/v1/agent-profiles', {}, s.keys.owner, { value: 'support-desk', label: 'Support desk', description: 'Answers on tasks.', tools: ['search_tasks', 'get_task', 'search_context'] });
    const taken = await v1(v1Profiles.POST, 'POST', '/api/v1/agent-profiles', {}, s.keys.owner, { value: 'generic', label: 'Mine', description: 'x' });
    const badTool = await v1(v1Profiles.POST, 'POST', '/api/v1/agent-profiles', {}, s.keys.owner, { value: 'typo', label: 'Typo', description: 'x', tools: ['no_such_tool'] });
    const noScope = await v1(v1Profiles.POST, 'POST', '/api/v1/agent-profiles', {}, s.keys.noTeam, { value: 'mine', label: 'Mine', description: 'x' });
    check('profiles: an Owner adds one; a code value is refused; an unknown tool is refused; it needs team.manage', profile.status === 201 && profile.body.data.source === 'workspace'
      && taken.status === 409 && reason(taken) === 'registry_key_taken' && badTool.status === 422 && noScope.status === 403, [profile.body, taken.body, badTool.body, noScope.status]);
    const listed = await v1(v1Profiles.GET, 'GET', '/api/v1/agent-profiles', {}, s.keys.owner);
    check('profiles: the list merges code and rows', JSON.stringify(listed.body?.data?.map((p: Loose) => `${p.value}:${p.source}`)) === '["generic:core","support-desk:workspace"]', listed.body);

    as(LOGINS.owner);
    const assign = await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.zed}`, { id: s.zed }, { agent_profile: 'support-desk' });
    const ghost = await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.zed}`, { id: s.zed }, { agent_profile: 'ghost' });
    check('profiles: an Owner sets a row profile on an agent; an unknown one is refused', assign.status === 200 && ghost.status === 422, [assign.status, assign.body, ghost.status]);
    const zedTools = await toolNames(s.keys.zed);
    check('profiles: a row profile narrows the tools, as code\'s do', JSON.stringify([...zedTools].sort()) === JSON.stringify(['get_task', 'pm_guide', 'search_context', 'search_tasks']), zedTools);
    const inUse = await v1(v1Profile.DELETE, 'DELETE', '/api/v1/agent-profiles/support-desk', { value: 'support-desk' }, s.keys.owner);
    check('profiles: one agents use cannot be archived', inUse.status === 409 && reason(inUse) === 'profile_in_use', inUse.body);

    // The four former core profiles resolve to the same tools as before.
    const ownerAccess: AccessContext = { member_id: 'x', role: 'agent', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
    const scopes = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'agent_activity.write', 'team.manage', 'team.read'];
    const generic = toolsFor({ access: ownerAccess, scopes, readOnly: false, profile: 'generic' }).map((tool) => tool.name);
    for (const value of ['coordinator', 'builder', 'auditor', 'reviewer']) {
      await s.q("INSERT INTO pm.mcp_profile_rows (value, label, description) VALUES ($1, $2, 'Former core') ON CONFLICT DO NOTHING", [value, value]);
      const definition = await resolveAgentProfile(service, value);
      const tools = toolsFor({ access: ownerAccess, scopes, readOnly: false, profile: value, profileDefinition: definition }).map((tool) => tool.name);
      check(`profiles: ${value} as a row sees exactly what it saw in core`, !!definition && JSON.stringify(tools) === JSON.stringify(generic), { value, tools: tools.length, generic: generic.length });
    }
    await s.q("UPDATE pm.team_members SET agent_profile = 'builder' WHERE id = $1", [s.zed]);
    check('profiles: a member stored on builder keeps every tool its key allows', (await toolNames(s.keys.zed)).length > 10);
    const archived = await v1(v1Profile.DELETE, 'DELETE', '/api/v1/agent-profiles/support-desk', { value: 'support-desk' }, s.keys.owner);
    check('profiles: once unused it archives, and resolves as unknown', archived.status === 200 && !!archived.body.data.archived_at && (await resolveAgentProfile(service, 'support-desk')) === null, archived.body);

    const template = await v1(v1Templates.POST, 'POST', '/api/v1/agent-templates', {}, s.keys.owner, {
      key: 'release-notes', label: 'Release notes', description: 'Writes release notes.', profile: 'builder',
      rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'approval' }, scopes: ['tasks.read', 'projects.read'], context: 'Each Friday, write release notes.',
    });
    const coreKey = await v1(v1Templates.POST, 'POST', '/api/v1/agent-templates', {}, s.keys.owner, {
      key: 'builder', label: 'Mine', description: 'x', rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'live' }, scopes: ['tasks.read'], context: 'x',
    });
    const badProfile = await v1(v1Templates.POST, 'POST', '/api/v1/agent-templates', {}, s.keys.owner, {
      key: 'ghosted', label: 'Ghost', description: 'x', profile: 'support-desk', rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'live' }, scopes: ['tasks.read'], context: 'x',
    });
    check('templates: an Owner adds one; a core key is refused; its profile must exist', template.status === 201 && coreKey.status === 409 && reason(coreKey) === 'registry_key_taken'
      && badProfile.status === 422, [template.body, coreKey.body, badProfile.body]);
    const templates = await v1(v1Templates.GET, 'GET', '/api/v1/agent-templates', {}, s.keys.owner);
    check('templates: the list is code\'s then the rows', templates.body?.data?.at(-1)?.key === 'release-notes' && templates.body.data.some((t: Loose) => t.key === 'builder'), templates.body?.data?.map((t: Loose) => t.key));
    const applied = await v1(v1Apply.POST, 'POST', `/api/v1/agents/${s.spec}/template`, { id: s.spec }, s.keys.owner, { template: 'release-notes' });
    const stored = (await s.q<Loose>('SELECT agent_template_key FROM pm.team_members WHERE id = $1', [s.spec]))[0];
    const packAfter = await myPack(s.keys.spec);
    check('templates: a row template applies, and the agent keeps its key in the column', applied.status === 200 && stored.agent_template_key === 'release-notes'
      && packAfter?.template?.key === 'release-notes', [applied.status, applied.body, stored]);
    const edited = await v1(v1Template.PATCH, 'PATCH', '/api/v1/agent-templates/release-notes', { key: 'release-notes' }, s.keys.owner, { context: 'Each Thursday, write release notes.' });
    check('templates: an Owner changes one', edited.status === 200 && edited.body.data.template.context.includes('Thursday'), edited.body);

    const doc = await v1(v1Export.GET, 'GET', '/api/v1/agent-registries/export', {}, s.keys.owner);
    check('export: the workspace\'s own profiles and templates, not code\'s', doc.status === 200 && doc.body.data.format === 'pm-agent-registries'
      && doc.body.data.templates.some((t: Loose) => t.key === 'release-notes') && !doc.body.data.profiles.some((p: Loose) => p.value === 'generic'), doc.body);
    const tampered = { ...doc.body.data, profiles: [...doc.body.data.profiles, { value: 'generic', label: 'Mine', description: 'x' }] };
    const dry = await v1(v1Import.POST, 'POST', '/api/v1/agent-registries/import', {}, s.keys.owner, { document: tampered, dry_run: true });
    check('import: a dry run plans updates and refuses a code key', dry.status === 200 && dry.body.data.dry_run === true && dry.body.data.templates.updated.includes('release-notes')
      && dry.body.data.profiles.refused.some((r: Loose) => r.key === 'generic' && r.reason === 'registry_key_taken'), dry.body);
    const fresh = { format: 'pm-agent-registries', version: 1, profiles: [{ value: 'triage-lite', label: 'Triage lite', description: 'Reads the inbox.', tools: ['list_inbox'] }],
      templates: [{ key: 'triager', label: 'Triager', description: 'Sorts mail.', profile: 'triage-lite', rules: { agent_self_assign: false, agent_close_policy: 'close', agent_create_policy: 'approval' }, scopes: ['tasks.read'], context: 'Sort mail.' }] };
    const imported = await v1(v1Import.POST, 'POST', '/api/v1/agent-registries/import', {}, s.keys.owner, { document: fresh });
    check('import: a profile and a template that names it come in together', imported.status === 200 && imported.body.data.profiles.created.includes('triage-lite')
      && imported.body.data.templates.created.includes('triager') && (await resolveAgentProfile(service, 'triage-lite')) !== null, imported.body);
    // An Owner never gets someone else's personal agent a key, by any door; the harness does.
    const apiKeysRoute = await import('../src/app/api/v1/api-keys/route');
    const rotateRoute = await import('../src/app/api/v1/api-keys/[id]/rotate/route');
    const assistantKeysRoute = await import('../src/app/api/workspace/assistants/[id]/keys/route');
    const claimRoute = await import('../src/app/api/v1/assistants/[id]/key/route');
    const ownerMint = await v1(apiKeysRoute.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { name: 'For Pip', member_id: s.pip, scopes: ['tasks.read'] });
    as(LOGINS.owner);
    const ownerSessionMint = await session(assistantKeysRoute.POST, 'POST', `/api/workspace/assistants/${s.pip}/keys`, { id: s.pip }, {});
    const pipKeyId = (await s.q<{ id: string }>('SELECT id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL LIMIT 1', [s.pip]))[0].id;
    const ownerRotate = await v1(rotateRoute.POST, 'POST', `/api/v1/api-keys/${pipKeyId}/rotate`, { id: pipKeyId }, s.keys.owner, {});
    check('keys: an Owner cannot mint or rotate a key for someone else\'s personal agent (403 personal_agent_owner_only)', [ownerMint, ownerSessionMint, ownerRotate].every((a) => a.status === 403 && reason(a) === 'personal_agent_owner_only'),
      [ownerMint.body, ownerSessionMint.body, ownerRotate.body]);
    as(LOGINS.ana);
    const anaMint = await session(assistantKeysRoute.POST, 'POST', `/api/workspace/assistants/${s.pip}/keys`, { id: s.pip }, { scopes: ['tasks.read'] });
    check('keys: the person still makes one for her own personal agent', anaMint.status === 201 && /^pk_live_/.test(anaMint.body?.data?.secret ?? ''), anaMint.body);
    await s.q('UPDATE pm.api_keys SET revoked_at = now() WHERE team_member_id = $1', [s.pip]);
    const collected = await v1(claimRoute.POST, 'POST', `/api/v1/assistants/${s.pip}/key`, { id: s.pip }, s.keys.harness, {});
    const collectedId = collected.body?.data?.key?.id as string;
    const harnessRotate = await v1(rotateRoute.POST, 'POST', `/api/v1/api-keys/${collectedId}/rotate`, { id: collectedId }, s.keys.harness, {});
    check('keys: the harness still collects and rotates a personal agent\'s key', collected.status === 201 && harnessRotate.status === 201, [collected.status, collected.body, harnessRotate.status, harnessRotate.body]);

    const ownerTools = await toolNames(s.keys.owner);
    check('mcp: the registry tools are setup tools an Owner\'s key sees, never an agent\'s', ['list_agent_profiles', 'create_agent_profile', 'update_agent_profile', 'create_agent_template', 'update_agent_template', 'export_agent_registries', 'import_agent_registries'].every((n) => ownerTools.includes(n))
      && !specTools.includes('create_agent_profile'), ownerTools);

    await chainChecks({ s, service, start, tree, delegate, brief, reason, callTool });
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`Handoff, context scopes and registries: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`Handoff, context scopes and registries: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
