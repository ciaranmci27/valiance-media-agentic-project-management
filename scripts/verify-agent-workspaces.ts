/**
 * Agent workspaces, end to end over the real routes (session routes with a
 * signed-in member, v1 routes with keys, MCP tools through routeCaller, a
 * fake PostgREST over PGlite with the full schema, a stand-in for Supabase
 * Auth):
 * - The migration (20261124000800_agent_workspaces.sql), run twice on the
 *   schema before it, matches schema.sql; existing context rows get the
 *   section their category maps to with updated_at untouched; the previous
 *   release's writes still work; the projects table's fleet columns keep
 *   their shape and values; existing agents start with no role and no owner;
 *   search is service role only.
 * - Template settings: every core template declares its role and settings;
 *   unknown keys, wrong types, missing required values and values out of
 *   range are refused, each named; a bad declaration stops the build.
 * - Hiring in one call: the agent with no sign-in, the template's role,
 *   profile and rules, owners, project access and assignments, a key shown
 *   once, connect snippets that never hold the key; refusals before any
 *   write; a failure partway undoes what the call made.
 * - Project agents: CRUD, settings checked, instructions bound, an agent
 *   reads only its own, a non-manager is refused, removing keeps access.
 * - Owners: escalation goes to escalate_to, then the first active owner,
 *   then the workspace Owner; an owner without team.manage edits their own
 *   agent and no other, cannot mint a key, assigns only on projects they
 *   reach; owner=me; an agent never owns.
 * - The profile page: an owner without agents.manage (in person or through
 *   a group) opens their agent's /agent/<id>; a member who does not own it
 *   does not; the rest of /agent stays on agents.manage.
 * - Role labels: set at hire, edited, filtered, distinct roles, in the pack
 *   and the export.
 * - The brief: sections from categories, pins, search ranking, and
 *   get_project_context / add_project_context answering what they always did.
 * - Context pack and get_task_brief carry the assignment and pinned entries,
 *   within their caps.
 * - Project setup in one call, its part permissions and its rollback.
 * - Scale: 100 agents, 100 assignments, 1000 entries: paged, bounded, and
 *   the reads use their indexes.
 *
 *   npm run -s test:agent-workspaces
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { ExtensionError } from '../src/lib/extensions/registry';
import { defineAgentTemplates, type AgentTemplate } from '../src/lib/extensions/agent-templates';
import { CORE_AGENT_TEMPLATES } from '../src/lib/agent-templates';
import { AGENT_ROLE_PATTERN, defaultSettings, normalizeAgentRole, validateTemplateSettings, type SettingsField } from '../src/lib/project-agents';
import { CATEGORY_SECTION, SECTION_CATEGORY } from '../src/lib/project-brief';
import { buildConnectInfo, CONNECT_KEY_ENV } from '../src/lib/agent-connect';
import { agentProfileAccess, agentProfileIdFrom } from '../src/lib/agents-ui';
import { hasPermission } from '../src/lib/access-control';

const MIGRATION = '20261124000800_agent_workspaces.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- WORKSPACES: PROJECT AGENTS, OWNERS AND BRIEF (20261124000800_agent_workspaces.sql)';
const FLEET_COLUMNS = ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestion_queue_cap',
  'audit_interval_hours', 'sensitive_paths', 'suggestions_per_cycle', 'repo_path'];
const LEGACY_CONTEXT_KEYS = ['id', 'project_id', 'category', 'content', 'source', 'file_path', 'is_active', 'created_at', 'updated_at'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-00000000a001', email: 'olivia@example.com' },
  morgan: { id: '00000000-0000-4000-8000-00000000a002', email: 'morgan@example.com' },
  mia: { id: '00000000-0000-4000-8000-00000000a003', email: 'mia@example.com' },
  guest: { id: '00000000-0000-4000-8000-00000000a004', email: 'gus@example.com' },
};
let signedIn = LOGINS.owner;

/** Supabase Auth: the signed-in user of the moment, and creating logins. */
function authStandIn(db: PGlite) {
  const emails = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
      return true;
    };
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const text = await new Promise<string>((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw));
      });
      const body = JSON.parse(text || '{}');
      const email = String(body.email).toLowerCase();
      if (emails.has(email)) return json(422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
      emails.add(email);
      const id = randomUUID();
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, email]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
    return false;
  };
}

/** Session routes read the signed-in user from cookies: this hands them whoever `signedIn` is. */
function installSession(supabaseUrl: string) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const store = {
    getAll: () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-24T00:00:00Z' };
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

// ── Pure: templates, settings, roles, connect ────────────────────────────

function pureChecks() {
  const roles = Object.fromEntries(CORE_AGENT_TEMPLATES.map((t) => [t.key, t.role]));
  check('templates: core roles are watcher, triage, builder, reporter',
    roles['data-health-watcher'] === 'watcher' && roles['inbox-triage'] === 'triage' && roles.builder === 'builder' && roles['weekly-reporter'] === 'reporter', roles);
  // The builder profile left core (an install that used it has it as a row), so the builder starts on generic.
  check('templates: the builder starts on the generic profile', CORE_AGENT_TEMPLATES.find((t) => t.key === 'builder')?.profile === undefined);
  check('templates: builder, watcher and reporter declare settings; triage none',
    ['builder', 'data-health-watcher', 'weekly-reporter'].every((key) => (CORE_AGENT_TEMPLATES.find((t) => t.key === key)?.settings?.length ?? 0) > 0)
      && !CORE_AGENT_TEMPLATES.find((t) => t.key === 'inbox-triage')?.settings);

  const fields: SettingsField[] = [
    { key: 'repo', label: 'Repository', type: 'url', required: true },
    { key: 'every', label: 'Every', type: 'number', min: 1, max: 24, default: 6 },
    { key: 'day', label: 'Day', type: 'select', options: ['mon', { value: 'fri', label: 'Friday' }], default: 'fri' },
    { key: 'merge', label: 'Merge', type: 'boolean', default: false },
    { key: 'paths', label: 'Paths', type: 'regex' },
    { key: 'note', label: 'Note', type: 'textarea', max: 10 },
  ];
  const ok = validateTemplateSettings(fields, { repo: 'https://github.com/acme/site' }, { withDefaults: true });
  check('settings: defaults fill what was left out', ok.ok && ok.settings.every === 6 && ok.settings.day === 'fri' && ok.settings.merge === false, ok);
  const reasons = (input: unknown, withDefaults = false) => {
    const result = validateTemplateSettings(fields, input, { withDefaults });
    return result.ok ? [] : result.errors.map((e) => `${e.key}:${e.reason}`);
  };
  check('settings: an unknown key is refused, by name', reasons({ repo: 'https://x.dev', branch: 'dev' }).includes('branch:unknown_setting'));
  check('settings: a wrong type is refused', reasons({ repo: 'https://x.dev', every: '6' }).includes('every:wrong_type')
    && reasons({ repo: 'https://x.dev', merge: 'yes' }).includes('merge:wrong_type'));
  check('settings: a missing required value is refused', reasons({}).includes('repo:required') && reasons({ repo: '' }).includes('repo:required'));
  check('settings: out of range, not an option, bad url, bad regex, too long', JSON.stringify(reasons({ repo: 'ftp://x', every: 99, day: 'sun', paths: '([', note: 'x'.repeat(11) }))
    === JSON.stringify(['repo:invalid_url', 'every:out_of_range', 'day:not_an_option', 'paths:invalid_regex', 'note:too_long']));
  check('settings: a template with no fields takes only {}', validateTemplateSettings(undefined, {}).ok && !validateTemplateSettings(undefined, { x: 1 }).ok);
  check('settings: not an object is refused', !validateTemplateSettings(fields, [1, 2]).ok);
  check('settings: defaultSettings', JSON.stringify(defaultSettings(fields)) === JSON.stringify({ every: 6, day: 'fri', merge: false }));

  const sample: AgentTemplate = {
    key: 'release-notes', label: 'Release notes', description: 'Writes release notes.',
    rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'approval' },
    scopes: ['tasks.read'], context: 'Draft release notes.',
  };
  const thrown = (template: AgentTemplate) => {
    try { defineAgentTemplates([template]); return null; } catch (error) { return error instanceof ExtensionError ? error.message : String(error); }
  };
  check('templates: a select without options stops the build', /no options/.test(thrown({ ...sample, settings: [{ key: 'day', label: 'Day', type: 'select' }] }) ?? ''));
  check('templates: a repeated settings key stops the build', /two settings use the key/.test(thrown({ ...sample, settings: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] }) ?? ''));
  check('templates: a default of the wrong type stops the build', /default/.test(thrown({ ...sample, settings: [{ key: 'n', label: 'N', type: 'number', default: 'six' }] }) ?? ''));
  check('templates: an unknown field type stops the build', /unknown type/.test(thrown({ ...sample, settings: [{ key: 'n', label: 'N', type: 'colour' as never }] }) ?? ''));
  check('templates: a role is checked by shape', /role "Big Boss"/.test(thrown({ ...sample, role: 'Big Boss' }) ?? '') && thrown({ ...sample, role: 'code-reviewer' }) === null);

  check('roles: lowercase words joined by dashes, 1 to 40', AGENT_ROLE_PATTERN.test('code-reviewer') && !AGENT_ROLE_PATTERN.test('Builder') && !AGENT_ROLE_PATTERN.test('a'.repeat(41)) && !AGENT_ROLE_PATTERN.test(''));
  check('roles: normalized from what a person types', normalizeAgentRole(' Code Reviewer ') === 'code-reviewer' && normalizeAgentRole('!!') === null);

  check('brief: every category maps to a section, and back', CATEGORY_SECTION.constraint === 'rules' && CATEGORY_SECTION.lesson_learned === 'history'
    && CATEGORY_SECTION.existing_work === 'history' && CATEGORY_SECTION.business_context === 'overview' && CATEGORY_SECTION.technical_decision === 'decisions'
    && SECTION_CATEGORY.links === 'business_context');

  const connect = buildConnectInfo('https://pm.example.com/');
  check('connect: MCP and REST addresses from the app URL', connect.mcp_url === 'https://pm.example.com/api/mcp' && connect.api_base === 'https://pm.example.com/api/v1');
  check('connect: Claude Code uses the HTTP transport and the x-api-key header from the env', connect.snippets.claude_code.includes('--transport http')
    && connect.snippets.claude_code.includes(`x-api-key: \${${CONNECT_KEY_ENV}}`));
  check('connect: Codex reads the key from the env as a bearer token', connect.snippets.codex.includes(`bearer_token_env_var = "${CONNECT_KEY_ENV}"`));
  check('connect: the generic mcp.json parses', JSON.parse(connect.snippets.generic_mcp_json).mcpServers.pm.url === connect.mcp_url);
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the agent workspaces section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Role label')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>(`INSERT INTO pm.projects (name, autonomous_enabled, auto_merge_enabled, integration_branch, production_branch,
    suggestion_queue_cap, audit_interval_hours, sensitive_paths, suggestions_per_cycle, repo_path)
    VALUES ('Fleet site', true, true, 'develop', 'release', 12, 6, '{^db/}', 4, '/srv/site') RETURNING id`))[0].id;
  const categories = ['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned'];
  for (const category of categories) {
    await q(`INSERT INTO pm.project_context (project_id, category, content, updated_at) VALUES ($1, $2, $3, '2026-01-02T03:04:05Z')`, [project, category, `A ${category} note`]);
  }
  const columns = async (db: PGlite) => (await db.query<Loose>(`SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
    WHERE table_schema = 'pm' AND table_name = 'projects' AND column_name = ANY($1) ORDER BY column_name`, [FLEET_COLUMNS])).rows;
  const fleetBefore = { columns: await columns(old), row: (await q(`SELECT ${FLEET_COLUMNS.join(', ')} FROM pm.projects WHERE id = $1`, [project]))[0] };

  await applyMigrationsFrom(old, MIGRATION);
  const rows = await q<Loose>('SELECT category, section, pinned, updated_at FROM pm.project_context ORDER BY category');
  check('upgrade: every existing entry gets the section its category maps to',
    rows.length === 5 && rows.every((row) => row.section === CATEGORY_SECTION[row.category as keyof typeof CATEGORY_SECTION] && row.pinned === false), rows);
  check('upgrade: their freshness (updated_at) is untouched', rows.every((row) => new Date(row.updated_at).toISOString() === '2026-01-02T03:04:05.000Z'), rows.map((r) => r.updated_at));
  const fleetAfter = { columns: await columns(old), row: (await q(`SELECT ${FLEET_COLUMNS.join(', ')} FROM pm.projects WHERE id = $1`, [project]))[0] };
  check('upgrade: the projects fleet columns keep their shape and values', JSON.stringify(fleetAfter) === JSON.stringify(fleetBefore) && fleetBefore.columns.length === 9, { fleetBefore, fleetAfter });
  // What 2.0.20 writes: a category only, and a category change.
  await q("INSERT INTO pm.project_context (project_id, category, content) VALUES ($1, 'constraint', 'Old code writes a category')", [project]);
  const written = (await q<Loose>("SELECT id, section FROM pm.project_context WHERE content = 'Old code writes a category'"))[0];
  check('upgrade: the previous release\'s insert gets its section', written?.section === 'rules', written);
  await q("UPDATE pm.project_context SET category = 'technical_decision' WHERE id = $1", [written.id]);
  check('upgrade: a category change moves the section along', (await q<Loose>('SELECT section FROM pm.project_context WHERE id = $1', [written.id]))[0].section === 'decisions');
  const member = (await q<Loose>('SELECT agent_role, description FROM pm.team_members WHERE id = $1', [agent]))[0];
  check('upgrade: existing agents have no role label and no owner', member.agent_role === null && (await q('SELECT 1 FROM pm.agent_owners')).length === 0);

  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await fresh.query<Loose>(`SELECT has_function_privilege('anon', 'pm.search_project_context(uuid, text, integer)', 'EXECUTE') AS anon,
    has_function_privilege('authenticated', 'pm.search_project_context(uuid, text, integer)', 'EXECUTE') AS authed,
    has_function_privilege('service_role', 'pm.search_project_context(uuid, text, integer)', 'EXECUTE') AS service`)).rows[0];
  check('search_project_context: service role only', grants && !grants.anon && !grants.authed && grants.service, grants);
  const person = (await fresh.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('P', 'p@example.com', 'member') RETURNING id")).rows[0].id;
  const bot = (await fresh.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('B', 'b@example.com', 'agent') RETURNING id")).rows[0].id;
  const bot2 = (await fresh.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('B2', 'b2@example.com', 'agent') RETURNING id")).rows[0].id;
  const fail = (sql: string, params: unknown[]) => fresh.query(sql, params).then(() => null, (e: Error) => e.message);
  check('database: an agent never owns an agent, nor itself', /never by another agent/.test(await fail('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [bot, bot2]) ?? '')
    && /cannot own itself/.test(await fail('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $1)', [bot]) ?? ''));
  check('database: only an agent has owners', /Only an agent has owners/.test(await fail('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [person, person]) ?? '')
    || /cannot own itself/.test(await fail('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [person, person]) ?? ''));
  const p2 = (await fresh.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('P2') RETURNING id")).rows[0].id;
  check('database: only an agent is assigned as an agent', /Only an agent member/.test(await fail('INSERT INTO pm.project_agents (project_id, agent_id) VALUES ($1, $2)', [p2, person]) ?? ''));
  check('database: instructions are bounded', /project_agents_instructions_length/.test(await fail('INSERT INTO pm.project_agents (project_id, agent_id, instructions) VALUES ($1, $2, $3)', [p2, bot, 'x'.repeat(8001)]) ?? ''));
  check('database: a role label is checked by shape', /team_members_agent_role_check/.test(await fail("UPDATE pm.team_members SET agent_role = 'Big Boss' WHERE id = $1", [bot]) ?? ''));
  await old.close();
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const ALL_SCOPES = ['team.manage', 'team.read', 'project_members.manage', 'api_keys.manage_all', 'webhooks.manage', 'tasks.read', 'tasks.create',
  'tasks.manage_assigned', 'projects.read', 'projects.manage', 'project_context.read', 'project_context.manage', 'goals.read', 'goals.manage',
  'notifications.send', 'agent_activity.write', 'files.read', 'time.manage_own'];

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
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const mia = await member('Mia', 'member', LOGINS.mia);
  const guest = await member('Gus', 'guest', LOGINS.guest);
  const legacy = await member('Legacy', 'agent');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.projects (name, created_at) VALUES ($1, now() - interval '1 day') RETURNING id", [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [morgan, mia]);
  const queue = await project('Queue', []);
  // Morgan reaches Side; no agent is on it.
  const side = await project('Side', [morgan]);
  // Morgan and Mia read only the projects they are on, as plain members.
  for (const m of [morgan, mia]) {
    for (const channel of ['app', 'api']) {
      await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', $2, 'deny') ON CONFLICT DO NOTHING", [m, channel]);
      await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.read', $2, 'allow') ON CONFLICT DO NOTHING", [m, channel]);
    }
  }
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ALL_SCOPES),
    ownerNoBrief: await key(owner, ['projects.manage', 'projects.read', 'project_members.manage']),
    morgan: await key(morgan, ['team.read', 'projects.read', 'project_context.read']),
    mia: await key(mia, ['team.read', 'projects.read']),
  };
  return { q, owner, morgan, mia, guest, legacy, apex, queue, side, keys };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  try {
    const hireRoute = await import('../src/app/api/workspace/agents/route');
    const rolesRoute = await import('../src/app/api/workspace/agents/roles/route');
    const agentRoute = await import('../src/app/api/workspace/agents/[id]/route');
    const meRoute = await import('../src/app/api/workspace/me/route');
    const agentContextRoute = await import('../src/app/api/workspace/agents/[id]/context/route');
    const agentKeysRoute = await import('../src/app/api/workspace/agents/[id]/keys/route');
    const agentRevokeRoute = await import('../src/app/api/workspace/agents/[id]/keys/[keyId]/revoke/route');
    const templatesRoute = await import('../src/app/api/workspace/agent-templates/route');
    const projectAgentsRoute = await import('../src/app/api/workspace/projects/[id]/agents/route');
    const projectAgentRoute = await import('../src/app/api/workspace/projects/[id]/agents/[agentId]/route');
    const briefRoute = await import('../src/app/api/workspace/projects/[id]/brief/route');
    const briefEntryRoute = await import('../src/app/api/workspace/projects/[id]/brief/[entryId]/route');
    const briefSearchRoute = await import('../src/app/api/workspace/projects/[id]/brief/search/route');
    const setupRoute = await import('../src/app/api/workspace/projects/setup/route');
    const workspaceProjectsRoute = await import('../src/app/api/workspace/projects/route');
    const v1Agents = await import('../src/app/api/v1/agents/route');
    const v1Agent = await import('../src/app/api/v1/agents/[id]/route');
    const v1MyProjects = await import('../src/app/api/v1/agents/me/projects/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const v1ProjectAgents = await import('../src/app/api/v1/projects/[id]/agents/route');
    const v1ProjectAgent = await import('../src/app/api/v1/projects/[id]/agents/[agentId]/route');
    const v1Context = await import('../src/app/api/v1/projects/[id]/context/route');
    const v1ContextSearch = await import('../src/app/api/v1/projects/[id]/context/search/route');
    const v1Setup = await import('../src/app/api/v1/projects/setup/route');
    const v1Brief = await import('../src/app/api/v1/tasks/[id]/brief/route');
    const v1Export = await import('../src/app/api/v1/agents/[id]/export/route');
    const v1Setup2 = await import('../src/app/api/v1/agents/[id]/setup/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller, toolsFor } = await import('../src/lib/mcp/server');
    const { SETUP_TOOLS } = await import('../src/lib/mcp/guide');
    const { resolveApiKey } = await import('../src/lib/api/middleware');
    const { escalationTarget } = await import('../src/lib/api/agent-rules');
    const { PACK_LIMITS } = await import('../src/lib/api/agent-context');
    const { BRIEF_LIMITS } = await import('../src/lib/api/task-brief');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
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
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };

    // --- Guests see no agent setup ------------------------------------------
    as(LOGINS.guest);
    const guestTemplates = await session(templatesRoute.GET, 'GET', '/api/workspace/agent-templates');
    const guestRoles = await session(rolesRoute.GET, 'GET', '/api/workspace/agents/roles');
    const guestList = await session(hireRoute.GET, 'GET', '/api/workspace/agents');
    check('guests: templates (private briefs of the install), roles and the list are refused',
      guestTemplates.status === 403 && guestRoles.status === 403 && guestList.status === 403
      && !guestTemplates.text.includes('You work the tasks assigned to you'), { templates: guestTemplates.status, roles: guestRoles.status, list: guestList.status });

    // --- Templates for the screens -----------------------------------------
    as(LOGINS.morgan);
    const templates = await session(templatesRoute.GET, 'GET', '/api/workspace/agent-templates');
    const builder = templates.body?.data?.templates?.find((t: Loose) => t.key === 'builder');
    check('templates route: each with its settings form, role and profile', templates.status === 200 && builder?.settings?.length === 5
      && builder.role === 'builder' && builder.default_role === 'builder' && builder.profile === null, templates.body);

    // --- Hiring: refusals before any write ---------------------------------
    const members = () => count("SELECT count(*)::int AS n FROM pm.team_members WHERE role = 'agent'");
    const before = await members();
    const morganHire = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Nope' });
    check('hire: only an Owner hires', morganHire.status === 403 && reason(morganHire) === 'owner_only', morganHire.body);
    as(LOGINS.owner);
    const badSettings = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Bad', template_key: 'builder', project_ids: [s.apex], project_settings: { [s.apex]: { settings: { branch: 'dev', merge_on_green: 'yes' } } },
    });
    check('hire: settings that do not fit the template are refused, each field named', badSettings.status === 422 && reason(badSettings) === 'invalid_settings'
      && badSettings.body.error.details.fields?.branch && badSettings.body.error.details.fields?.merge_on_green, badSettings.body);
    const tooLong = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Long', project_ids: [s.apex], project_settings: { [s.apex]: { instructions: 'x'.repeat(8001) } },
    });
    check('hire: instructions over 8000 characters are refused', tooLong.status === 422, tooLong.body);
    const never = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Wide', create_key: true, scopes: ['tasks.read', 'audit.export'] });
    check('hire: a scope an agent key never carries is refused, even for an Owner', never.status === 422 && reason(never) === 'scope_never_for_agents', never.body);
    const agentOwner = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Owned', owner_ids: [s.legacy] });
    check('hire: an agent cannot be an owner', agentOwner.status === 422 && reason(agentOwner) === 'owner_is_agent', agentOwner.body);
    check('hire: refusals wrote nothing', (await members()) === before);

    // --- Hiring end to end ----------------------------------------------------
    const hired = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Jeff', title: 'Builder', description: 'Builds the site.', template_key: 'builder', owner_ids: [s.owner, s.morgan],
      project_ids: [s.apex, s.queue],
      project_settings: { [s.apex]: { settings: { repository_url: 'https://github.com/acme/site' }, instructions: 'Ship small changes. Never touch billing.' } },
      create_key: true,
    });
    const jeff = hired.body?.data;
    const jeffId = jeff?.agent?.id as string;
    const secret = jeff?.key?.secret as string;
    check('hire: 201 with the agent, never cached', hired.status === 201 && hired.headers.get('cache-control') === 'no-store' && !!jeffId, hired.body);
    check('hire: the template sets role, profile and rules', jeff?.agent?.agent_role === 'builder' && jeff?.agent?.agent_profile === 'generic'
      && jeff?.rules?.agent_close_policy === 'review' && jeff?.rules?.agent_self_assign === false && jeff?.template_key === 'builder', jeff);
    check('hire: its owners are those named', JSON.stringify(jeff?.agent?.owners?.map((o: Loose) => o.id)) === JSON.stringify([s.owner, s.morgan]), jeff?.agent?.owners);
    // One hire per request id: a double click (two calls in one tick) makes one agent and one key.
    {
      const requestId = randomUUID();
      const twiceBody = { name: 'Twice', create_key: true, scopes: ['tasks.read'], request_id: requestId };
      const [first, second] = await Promise.all([
        session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, twiceBody),
        session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, twiceBody),
      ]);
      const made = [first, second].filter((answer) => answer.status === 201);
      const refused = [first, second].filter((answer) => answer.status === 409);
      const twiceAgents = await count("SELECT count(*)::int AS n FROM pm.team_members WHERE name = 'Twice' AND role = 'agent'");
      const twiceKeys = await count("SELECT count(*)::int AS n FROM pm.api_keys k JOIN pm.team_members m ON m.id = k.team_member_id WHERE m.name = 'Twice'");
      check('hire: two calls with one request id make one agent and one key; the other is refused', made.length === 1 && refused.length === 1
        && ['already_hired', 'hire_in_progress'].includes(reason(refused[0])) && twiceAgents === 1 && twiceKeys === 1,
        { statuses: [first.status, second.status], reasons: refused.map(reason), twiceAgents, twiceKeys });
      const retry = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, twiceBody);
      check('hire: a retry of a hire that went through is 409 already_hired with its agent, and makes nothing', retry.status === 409 && reason(retry) === 'already_hired'
        && retry.body?.error?.details?.agent_id === made[0]?.body?.data?.agent?.id
        && await count("SELECT count(*)::int AS n FROM pm.team_members WHERE name = 'Twice' AND role = 'agent'") === 1, retry.body);
      // A hire killed half way: its unfinished claim holds the id for two minutes, then a retry takes it over.
      const stuckId = randomUUID();
      const freshId = randomUUID();
      await s.q("INSERT INTO pm.agent_hire_requests (request_id, hired_by, created_at) VALUES ($1, $3, now() - interval '5 minutes'), ($2, $3, now())", [stuckId, freshId, s.owner]);
      const revived = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Revived', request_id: stuckId });
      const stillRunning = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Too Soon', request_id: freshId });
      check('hire: an unfinished claim older than two minutes is free again; a fresh one still holds', revived.status === 201
        && stillRunning.status === 409 && reason(stillRunning) === 'hire_in_progress'
        && (await s.q<{ agent_id: string | null }>('SELECT agent_id FROM pm.agent_hire_requests WHERE request_id = $1', [stuckId]))[0]?.agent_id === revived.body?.data?.agent?.id,
        { revived: revived.status, revivedBody: revived.body?.error, stillRunning: stillRunning.status });
      // The API and MCP honour the same id: the second call hires nothing more.
      const mcpId = randomUUID();
      const mcpFirst = await runTool(s.keys.owner, s.owner, 'hire_agent', { name: 'Once Over MCP', request_id: mcpId });
      const mcpSecond = await runTool(s.keys.owner, s.owner, 'hire_agent', { name: 'Once Over MCP', request_id: mcpId });
      check('hire: over MCP a second hire_agent with the same request_id is already_hired', mcpFirst?.ok === true && mcpSecond?.ok === false
        && mcpSecond?.error?.reason === 'already_hired' && await count("SELECT count(*)::int AS n FROM pm.team_members WHERE name = 'Once Over MCP'") === 1,
        { mcpFirst: mcpFirst?.ok, mcpSecond });
    }
    // Owners as sent: the hirer only when none are named.
    const handedOff = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Handed Off', owner_ids: [s.mia] });
    check('hire: owners are honoured as sent, without the hirer', handedOff.status === 201
      && JSON.stringify(handedOff.body?.data?.agent?.owners?.map((o: Loose) => o.id)) === JSON.stringify([s.mia]), handedOff.body);
    const unnamed = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Unnamed Owners', owner_ids: [] });
    check('hire: with no owners named, the hirer owns it', unnamed.status === 201
      && JSON.stringify(unnamed.body?.data?.agent?.owners?.map((o: Loose) => o.id)) === JSON.stringify([s.owner]), unnamed.body);
    // A power the agent role lacks: an Owner gives it to this agent, so the key carries it and it works.
    const ownerActForBefore = await count("SELECT count(*)::int AS n FROM pm.role_permissions WHERE role = 'agent' AND permission_key = 'agents.act_for'");
    const delegate = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Delegate', create_key: true, scopes: ['tasks.read', 'agents.act_for'] });
    const delegateId = delegate.body?.data?.agent?.id as string;
    check('hire: an Owner gives a power beyond the agent role; the key carries it', ownerActForBefore === 0 && delegate.status === 201
      && delegate.body?.data?.key?.scopes?.includes('agents.act_for') && JSON.stringify(delegate.body?.data?.scopes_beyond_role) === JSON.stringify(['agents.act_for'])
      && await count("SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'agents.act_for' AND access_channel = 'api' AND effect = 'allow'", [delegateId]) === 1, delegate.body);
    {
      const { mintForSession } = await import('../src/lib/api/delegation');
      const { resolveMemberAccess } = await import('../src/lib/api/access');
      const ownerAccess = await resolveMemberAccess(service, s.owner);
      const grant = await mintForSession(service, { memberId: s.owner, access: ownerAccess! }, delegateId).catch((e: Error) => e);
      check('hire: the agent given Act for a person can act for someone', !(grant instanceof Error) && grant.agent_id === delegateId, grant);
      const { assertMayGiveAgentScopes } = await import('../src/lib/api/agent-scope-grants');
      const morganAccess = await resolveMemberAccess(service, s.morgan);
      let refused: Loose = null;
      try { assertMayGiveAgentScopes({ ...morganAccess!, api_permissions: ['*'] }, ['agents.act_for']); } catch (e) { refused = e; }
      check('scope grants: someone who is not an Owner is refused a power beyond the agent role', refused?.statusCode === 403 && refused?.details?.reason === 'scope_needs_owner', refused);
    }
    const apexAssignment = jeff?.assignments?.find((a: Loose) => a.project_id === s.apex);
    check('hire: assignments carry checked settings with the template\'s defaults', jeff?.assignments?.length === 2
      && apexAssignment?.settings?.repository_url === 'https://github.com/acme/site' && apexAssignment?.settings?.working_branch === 'dev'
      && apexAssignment?.settings?.merge_on_green === false && apexAssignment?.instructions.startsWith('Ship small') && apexAssignment?.settings_schema?.length === 5, jeff?.assignments);
    check('hire: it got project access on both', await count('SELECT count(*)::int AS n FROM pm.project_members WHERE member_id = $1', [jeffId]) === 2);
    check('hire: no sign-in (a login it never uses, no invite link)', await count('SELECT count(*)::int AS n FROM pm.team_invites WHERE member_id = $1', [jeffId]) === 0);
    check('hire: the key carries the template\'s scopes', /^pk_live_/.test(secret ?? '') && JSON.stringify([...jeff.key.scopes].sort()) === JSON.stringify([...CORE_AGENT_TEMPLATES.find((t) => t.key === 'builder')!.scopes].sort()), jeff?.key);
    check('hire: the secret is in the key block only', hired.text.split(secret).length === 2 && !JSON.stringify(jeff.connect).includes(secret), jeff?.connect);
    check('hire: connect snippets from NEXT_PUBLIC_APP_URL', jeff?.connect?.mcp_url === 'https://pm.example.com/api/mcp'
      && jeff.connect.snippets.claude_code.includes('claude mcp add --transport http pm https://pm.example.com/api/mcp') && !!jeff.connect.snippets.codex && !!jeff.connect.snippets.env, jeff?.connect);
    const resolved = await resolveApiKey(secret).catch(() => null);
    check('hire: the key works, as the agent', resolved?.keyRow.team_member_id === jeffId);
    await settle();
    const audit = await s.q<{ body: string }>('SELECT coalesce(request_body::text, \'\') || coalesce(after_snapshot::text, \'\') AS body FROM pm.api_audit_log');
    check('hire: no secret in the audit log', !audit.some((row) => row.body.includes(secret)));

    // --- Hiring rolls back on a failure partway -----------------------------
    await db.exec('RESET ROLE');
    await db.exec(`CREATE FUNCTION pm.test_fail_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.instructions = 'FAIL' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_assignment BEFORE INSERT ON pm.project_agents FOR EACH ROW EXECUTE FUNCTION pm.test_fail_assignment();`);
    const failed = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Broken', template_key: 'builder', owner_ids: [s.morgan], project_ids: [s.queue], project_settings: { [s.queue]: { instructions: 'FAIL' } }, create_key: true,
      scopes: [...CORE_AGENT_TEMPLATES.find((t) => t.key === 'builder')!.scopes, 'agents.act_for'],
    });
    const brokenId = failed.body?.error?.details?.agent_id;
    check('rollback: the hire answers what happened', failed.status >= 500 && reason(failed) === 'hire_incomplete' && !!brokenId, failed.body);
    const broken = brokenId ? (await s.q<Loose>('SELECT status FROM pm.team_members WHERE id = $1', [brokenId]))[0] : null;
    check('rollback: the agent is suspended, with no access, owners, assignments or live key', broken?.status === 'suspended'
      && await count('SELECT count(*)::int AS n FROM pm.project_members WHERE member_id = $1', [brokenId]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE agent_id = $1', [brokenId]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.project_agents WHERE agent_id = $1', [brokenId]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [brokenId]) === 0, broken);
    check('rollback: the powers it was given beyond the agent role are taken back',
      await count('SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1', [brokenId]) === 0
      && (failed.body?.error?.details?.rolled_back ?? []).includes('powers beyond its role removed'), failed.body?.error?.details);

    // --- Lists, roles, detail -------------------------------------------------
    const list = await session(hireRoute.GET, 'GET', '/api/workspace/agents');
    const listed = list.body?.data?.agents?.find((a: Loose) => a.id === jeffId);
    check('list: each agent with owners, template, counts and health', list.status === 200 && listed?.template_key === 'builder' && listed?.owners?.length === 2
      && listed?.assignments?.total === 2 && listed?.project_ids?.length === 2 && 'health' in listed && 'current_run' in listed && list.body.data.meta.total >= 2, listed);
    const byRole = await session(hireRoute.GET, 'GET', '/api/workspace/agents?role=builder&status=active');
    check('list: filter by role and status', byRole.body?.data?.agents?.length === 1 && byRole.body.data.agents[0].id === jeffId, byRole.body?.data);
    as(LOGINS.morgan);
    const mine = await session(hireRoute.GET, 'GET', '/api/workspace/agents?owner=me');
    check('list: owner=me lists the agents the viewer owns', JSON.stringify(mine.body?.data?.agents?.map((a: Loose) => a.id)) === JSON.stringify([jeffId]), mine.body?.data);
    const byTemplate = await session(hireRoute.GET, 'GET', `/api/workspace/agents?template=builder&project=${s.apex}`);
    check('list: filter by template and project', byTemplate.body?.data?.agents?.length === 1);
    // Project access through membership alone (pm.project_members), as live agents have it: no assignments.
    const memberOnly = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Member Only', 'member-only@agents.example.com', 'agent') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $3), ($2, $3)', [s.apex, s.side, memberOnly]);
    as(LOGINS.owner);
    const ownerSeesAccess = (await session(hireRoute.GET, 'GET', '/api/workspace/agents?search=Member%20Only')).body?.data?.agents?.[0];
    check('list: project access through membership, apart from assignments', ownerSeesAccess?.access_total === 2 && ownerSeesAccess?.access_project_ids?.length === 2
      && ownerSeesAccess?.project_ids?.length === 0 && ownerSeesAccess?.assignments?.total === 0, ownerSeesAccess);
    as(LOGINS.mia);
    const miaSeesAccess = (await session(hireRoute.GET, 'GET', '/api/workspace/agents?search=Member%20Only')).body?.data?.agents?.[0];
    check('list: a viewer reaching one of them sees that id, and the total counted', JSON.stringify(miaSeesAccess?.access_project_ids) === JSON.stringify([s.apex])
      && miaSeesAccess?.access_total === 2, miaSeesAccess);
    const miaDetail = await session(agentRoute.GET, 'GET', `/api/workspace/agents/${memberOnly}`, { id: memberOnly });
    check('detail: project access by the same rule', miaDetail.body?.data?.project_access?.projects?.length === 1 && miaDetail.body.data.project_access.projects[0].id === s.apex
      && miaDetail.body.data.project_access.hidden_count === 1 && miaDetail.body.data.project_access.total === 2, miaDetail.body?.data?.project_access);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [memberOnly]);
    as(LOGINS.morgan);
    const roles = await session(rolesRoute.GET, 'GET', '/api/workspace/agents/roles');
    check('roles: the distinct roles in use', JSON.stringify(roles.body?.data?.roles) === JSON.stringify(['builder']) && roles.body.data.counts.builder === 2, roles.body);
    const morganDetail = await session(agentRoute.GET, 'GET', `/api/workspace/agents/${jeffId}`, { id: jeffId });
    check('detail: an owner may manage it; keys are left out without api_keys.manage_all', morganDetail.status === 200 && morganDetail.body.data.can_manage === true
      && morganDetail.body.data.keys === undefined && morganDetail.body.data.omitted.includes('keys') && morganDetail.body.data.owners.length === 2, morganDetail.body);
    check('detail: assignments on projects the viewer reaches only', morganDetail.body?.data?.projects?.length === 1 && morganDetail.body.data.projects[0].project_id === s.apex
      && morganDetail.body.data.projects_hidden === 1, morganDetail.body?.data?.projects);

    // --- The profile page: who opens /agent/<id> ---------------------------
    // The /agent layout's rule (agentProfileAccess) over what the screen reads:
    // the signed-in person's access (/api/workspace/me) and the profile read.
    const profileAccess = async (agentId: string) => {
      const me = await session(meRoute.GET, 'GET', '/api/workspace/me');
      const detail = await session(agentRoute.GET, 'GET', `/api/workspace/agents/${agentId}`, { id: agentId });
      const manageAgents = hasPermission(me.body?.data?.access, 'agents.manage');
      return { manageAgents, isOwner: detail.body?.data?.is_owner, open: agentProfileAccess({ manageAgents, isOwner: detail.body?.data?.is_owner }) };
    };
    check('profile: only /agent/<id> is a profile; the home, hire flow, analytics and project views are not',
      agentProfileIdFrom(`/agent/${jeffId}`) === jeffId && agentProfileIdFrom('/agent') === null && agentProfileIdFrom('/agent/new') === null
      && agentProfileIdFrom('/agent/analytics') === null && agentProfileIdFrom(`/agent/projects/${s.apex}`) === null);
    const morganOpens = await profileAccess(jeffId);
    check('profile: an owner without agents.manage opens their agent', !morganOpens.manageAgents && morganOpens.isOwner === true && morganOpens.open === 'owner', morganOpens);
    const morganLegacy = await profileAccess(s.legacy);
    check('profile: and not an agent they do not own', morganLegacy.isOwner === false && morganLegacy.open === null, morganLegacy);
    as(LOGINS.mia);
    const miaOpens = await profileAccess(jeffId);
    check('profile: a member who does not own it does not open it', !miaOpens.manageAgents && miaOpens.isOwner === false && miaOpens.open === null, miaOpens);
    const crew = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Site crew', 'site-crew-profile') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [crew, s.mia]);
    await s.q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [jeffId, crew]);
    const miaThroughGroup = await profileAccess(jeffId);
    check('profile: a member of a group that owns it opens it', miaThroughGroup.isOwner === true && miaThroughGroup.open === 'owner', miaThroughGroup);
    // The group goes to Trash: its ownership ends with it, and so does the way in.
    await s.q('UPDATE pm.groups SET deleted_at = now() WHERE id = $1', [crew]);
    const miaAfterTrash = await profileAccess(jeffId);
    check('profile: a group in Trash owns nothing', miaAfterTrash.isOwner === false && miaAfterTrash.open === null, miaAfterTrash);
    as(LOGINS.owner);
    const ownerOpens = await profileAccess(s.legacy);
    check('profile: agents.manage opens any agent', ownerOpens.manageAgents && ownerOpens.open === 'manage', ownerOpens);
    as(LOGINS.owner);
    const ownerDetail = await session(agentRoute.GET, 'GET', `/api/workspace/agents/${jeffId}`, { id: jeffId });
    check('detail: the Owner sees keys (never a secret) and the template', ownerDetail.body?.data?.keys?.length === 1 && ownerDetail.body.data.template_key === 'builder'
      && !ownerDetail.text.includes(secret) && ownerDetail.body.data.agent.description === 'Builds the site.', ownerDetail.body?.data);

    // --- Owners: delegated management ---------------------------------------
    as(LOGINS.morgan);
    const morganEdit = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${jeffId}`, { id: jeffId }, { name: 'Jeff B', agent_role: 'code-builder', rules: { close_policy: 'close' } });
    check('owners: an owner without team.manage edits their agent', morganEdit.status === 200 && morganEdit.body.data.agent.name === 'Jeff B'
      && morganEdit.body.data.agent.agent_role === 'code-builder' && morganEdit.body.data.rules.agent_close_policy === 'close', morganEdit.body);
    const morganOther = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.legacy}`, { id: s.legacy }, { name: 'Hacked' });
    check('owners: and not another agent', morganOther.status === 403 && reason(morganOther) === 'not_agent_owner', morganOther.body);
    const morganKey = await session(agentKeysRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys`, { id: jeffId }, { scopes: ['tasks.read'] });
    check('owners: an owner cannot mint a key without the setup API\'s conditions', morganKey.status === 403, morganKey.body);
    const morganAssignQueue = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.queue}/agents/${jeffId}`, { id: s.queue, agentId: jeffId }, { status: 'paused' });
    check('owners: assignments only on projects the owner reaches', morganAssignQueue.status === 403 && reason(morganAssignQueue) === 'project_scope', morganAssignQueue.body);
    const morganSide = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.side}/agents/${jeffId}`, { id: s.side, agentId: jeffId }, { instructions: 'Help on Side.' });
    check('owners: an owner without project_members.manage cannot give their agent project access', morganSide.status === 403 && reason(morganSide) === 'project_access_needed'
      && await count('SELECT count(*)::int AS n FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [s.side, jeffId]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.project_agents WHERE project_id = $1 AND agent_id = $2', [s.side, jeffId]) === 0, morganSide.body);
    const mcpSide = await runTool(s.keys.morgan, s.morgan, 'set_project_agent', { project_id: s.side, agent_id: jeffId, instructions: 'Help on Side.' });
    check('owners: the same refusal over MCP', mcpSide?.ok === false && mcpSide.status === 403 && mcpSide.error?.reason === 'project_access_needed', mcpSide);
    const morganAssign = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.apex}/agents/${jeffId}`, { id: s.apex, agentId: jeffId }, { instructions: 'Ship small. Ask before migrations.' });
    check('owners: an owner changes their agent\'s instructions where they reach', morganAssign.status === 200 && morganAssign.body.data.assignment.instructions.includes('Ask before'), morganAssign.body);
    as(LOGINS.owner);
    const ownerSide = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.side}/agents/${jeffId}`, { id: s.side, agentId: jeffId }, { status: 'paused' });
    check('owners: an Owner adds project access with the assignment', ownerSide.status === 200 && ownerSide.body.data.created === true && ownerSide.body.data.access_added === true, ownerSide.body);
    as(LOGINS.morgan);
    const morganConfigures = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.side}/agents/${jeffId}`, { id: s.side, agentId: jeffId }, { status: 'active', instructions: 'Help on Side.' });
    check('owners: once the agent is on the project, its owner configures the assignment', morganConfigures.status === 200 && morganConfigures.body.data.assignment.status === 'active', morganConfigures.body);
    as(LOGINS.owner);
    await session(projectAgentRoute.DELETE, 'DELETE', `/api/workspace/projects/${s.side}/agents/${jeffId}`, { id: s.side, agentId: jeffId });
    await s.q('DELETE FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [s.side, jeffId]);
    as(LOGINS.morgan);
    const morganOwners = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${jeffId}`, { id: jeffId }, { owner_ids: [s.morgan, s.owner, s.mia] });
    check('owners: an existing owner adds owners', morganOwners.status === 200 && morganOwners.body.data.owners.length === 3, morganOwners.body);
    as(LOGINS.mia);
    const miaOwners = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.legacy}`, { id: s.legacy }, { owner_ids: [s.mia] });
    check('owners: a member who owns nothing cannot take ownership', miaOwners.status === 403, miaOwners.body);
    as(LOGINS.owner);
    await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${jeffId}`, { id: jeffId }, { owner_ids: [s.owner, s.morgan] });
    const v1Own = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${jeffId}`, { id: jeffId }, s.keys.morgan, { title: 'Lead builder' });
    const v1Other = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.legacy}`, { id: s.legacy }, s.keys.morgan, { title: 'Nope' });
    check('owners: the same rule over v1 (own agent yes, another no)', v1Own.status === 200 && v1Own.body.data.agent.title === 'Lead builder' && v1Other.status === 403, { own: v1Own.body, other: v1Other.body });
    const mcpOther = await runTool(s.keys.morgan, s.morgan, 'update_agent', { agent_id: s.legacy, name: 'Nope' });
    check('owners: and over MCP', mcpOther?.ok === false && mcpOther.status === 403, mcpOther);
    const roleOnPerson = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.mia}`, { id: s.mia }, s.keys.owner, { agent_role: 'builder' });
    check('roles: a role label is for agents only', roleOnPerson.status === 422 && reason(roleOnPerson) === 'agents_only', roleOnPerson.body);

    // --- Escalation order ------------------------------------------------------
    check('escalation: no owner, no target: the workspace Owner', await escalationTarget(service, s.legacy) === s.owner);
    await s.q('INSERT INTO pm.agent_owners (agent_id, member_id, created_at) VALUES ($1, $2, now() - interval \'2 minutes\'), ($1, $3, now() - interval \'1 minute\')', [s.legacy, s.morgan, s.mia]);
    check('escalation: no target: its first active owner', await escalationTarget(service, s.legacy) === s.morgan);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.morgan]);
    check('escalation: a suspended owner is skipped', await escalationTarget(service, s.legacy) === s.mia);
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.morgan]);
    await s.q('UPDATE pm.team_members SET agent_escalate_to = $1 WHERE id = $2', [s.owner, s.legacy]);
    check('escalation: its own target comes first', await escalationTarget(service, s.legacy) === s.owner);
    await s.q('UPDATE pm.team_members SET agent_escalate_to = NULL WHERE id = $1', [s.legacy]);
    await s.q('DELETE FROM pm.agent_owners WHERE agent_id = $1', [s.legacy]);

    // --- Project agents ---------------------------------------------------------
    const projectList = await session(projectAgentsRoute.GET, 'GET', `/api/workspace/projects/${s.apex}/agents`, { id: s.apex });
    check('project agents: listed with the settings form', projectList.status === 200 && projectList.body.data.assignments.length === 1
      && projectList.body.data.assignments[0].agent_name === 'Jeff B' && projectList.body.data.assignments[0].settings_schema.length === 5 && projectList.body.data.meta.total === 1, projectList.body);
    const unknownKey = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.apex}/agents/${jeffId}`, { id: s.apex, agentId: jeffId }, { settings: { repository: 'x' } });
    const wrongType = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.apex}/agents/${jeffId}`, { id: s.apex, agentId: jeffId }, { settings: { merge_on_green: 1 } });
    check('project agents: unknown setting and wrong type refused', reason(unknownKey) === 'invalid_settings' && unknownKey.body.error.details.errors[0].reason === 'unknown_setting'
      && wrongType.body.error.details.errors[0].reason === 'wrong_type', { unknownKey: unknownKey.body, wrongType: wrongType.body });
    const watcherSwap = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.queue}/agents/${jeffId}`, { id: s.queue, agentId: jeffId }, { template_key: 'data-health-watcher', settings: { check_interval_hours: 0 } });
    check('project agents: a new template checks its own settings (out of range)', watcherSwap.status === 422 && watcherSwap.body.error.details.errors[0].reason === 'out_of_range', watcherSwap.body);
    const unknownTemplate = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.queue}/agents/${jeffId}`, { id: s.queue, agentId: jeffId }, { template_key: 'rocket' });
    check('project agents: the template must exist', reason(unknownTemplate) === 'unknown_template', unknownTemplate.body);
    const longInstructions = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.queue}/agents/${jeffId}`, { id: s.queue, agentId: jeffId }, { instructions: 'x'.repeat(8001) });
    check('project agents: instructions are bounded', longInstructions.status === 422, longInstructions.body);
    as(LOGINS.mia);
    const miaPut = await session(projectAgentRoute.PUT, 'PUT', `/api/workspace/projects/${s.apex}/agents/${jeffId}`, { id: s.apex, agentId: jeffId }, { status: 'paused' });
    check('project agents: a non-manager who does not own the agent is refused', miaPut.status === 403 && reason(miaPut) === 'not_agent_owner', miaPut.body);
    as(LOGINS.owner);
    // A second agent on Apex, to show an agent reads only its own.
    const ada = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Ada', agent_role: 'reviewer', template_key: 'weekly-reporter', project_ids: [s.apex], create_key: true,
      project_settings: { [s.apex]: { instructions: 'Ada only: report to the client on Fridays.' } },
    });
    const adaId = ada.body?.data?.agent?.id;
    const adaSecret = ada.body?.data?.key?.secret;
    check('hire: a role label given wins over the template\'s', ada.body?.data?.agent?.agent_role === 'reviewer', ada.body);
    const jeffSees = await v1(v1ProjectAgents.GET, 'GET', `/api/v1/projects/${s.apex}/agents`, { id: s.apex }, secret);
    check('project agents: an agent reads only its own assignment', jeffSees.status === 200 && jeffSees.body.data.length === 1 && jeffSees.body.data[0].agent_id === jeffId, jeffSees.body);
    const ownerSees = await v1(v1ProjectAgents.GET, 'GET', `/api/v1/projects/${s.apex}/agents`, { id: s.apex }, s.keys.owner);
    check('project agents: a person who can open the project reads every one', ownerSees.body?.data?.length === 2, ownerSees.body);
    const myProjects = await v1(v1MyProjects.GET, 'GET', '/api/v1/agents/me/projects', {}, secret);
    check('my projects: the caller\'s assignments with settings and instructions', myProjects.status === 200 && myProjects.body.data.length === 2
      && myProjects.body.data.every((a: Loose) => a.agent_id === jeffId) && myProjects.body.meta.total === 2, myProjects.body);
    const mcpMine = await runTool(secret, jeffId, 'list_my_projects', {});
    check('my projects: list_my_projects over MCP', mcpMine?.ok === true && mcpMine.data.length === 2, mcpMine);
    const mcpSet = await runTool(s.keys.owner, s.owner, 'set_project_agent', { project_id: s.queue, agent_id: adaId, settings: { report_day: 'monday' }, template_key: 'weekly-reporter' });
    check('project agents: set_project_agent adds an assignment and access', mcpSet?.ok === true && mcpSet.data.created === true && mcpSet.data.access_added === true
      && mcpSet.data.assignment.settings.report_day === 'monday', mcpSet);
    const mcpRemove = await runTool(s.keys.owner, s.owner, 'remove_project_agent', { project_id: s.queue, agent_id: adaId });
    check('project agents: remove_project_agent removes it, access stays', mcpRemove?.ok === true && mcpRemove.data.removed === true
      && await count('SELECT count(*)::int AS n FROM pm.project_members WHERE member_id = $1 AND project_id = $2', [adaId, s.queue]) === 1, mcpRemove);
    const del = await session(projectAgentRoute.DELETE, 'DELETE', `/api/workspace/projects/${s.queue}/agents/${adaId}`, { id: s.queue, agentId: adaId });
    check('project agents: removing again reports nothing removed', del.status === 200 && del.body.data.removed === false, del.body);

    // --- The brief --------------------------------------------------------------
    const legacyAdd = await v1(v1Context.POST, 'POST', `/api/v1/projects/${s.apex}/context`, { id: s.apex }, s.keys.owner, { category: 'constraint', content: 'Never deploy on Fridays.' });
    check('compat: add_project_context answers its nine columns, in order', legacyAdd.status === 201 && JSON.stringify(Object.keys(legacyAdd.body.data)) === JSON.stringify(LEGACY_CONTEXT_KEYS), legacyAdd.body);
    // A second key for Jeff from the screens, with the context scopes; then revoked.
    const contextKey = await session(agentKeysRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys`, { id: jeffId }, { name: 'Context', scopes: ['project_context.read', 'project_context.manage'] });
    const contextSecret = contextKey.body?.data?.key?.secret as string;
    check('keys: the Owner mints a key from the screens, its secret once, never cached', contextKey.status === 201 && /^pk_live_/.test(contextSecret ?? '')
      && contextKey.headers.get('cache-control') === 'no-store' && contextKey.body.data.key.prefix === contextSecret.slice(0, 15), contextKey.body);
    // A power its role lacks: the Owner's key gives it to Jeff alone (a per-member allow), as the hire does.
    const heldBefore = ((await session(agentRoute.GET, 'GET', `/api/workspace/agents/${jeffId}`, { id: jeffId })).body?.data?.key_scopes_available ?? []) as string[];
    const extra = ['files.upload', 'goals.manage', 'contacts.read', 'team.read'].find((scope) => !heldBefore.includes(scope)) as string;
    const grantRows = () => count("SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = $2 AND access_channel = 'api' AND effect = 'allow'", [jeffId, extra]);
    const beyondKey = await session(agentKeysRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys`, { id: jeffId }, { name: 'Beyond', scopes: [extra] });
    const heldAfter = ((await session(agentRoute.GET, 'GET', `/api/workspace/agents/${jeffId}`, { id: jeffId })).body?.data?.key_scopes_available ?? []) as string[];
    check('keys: the Owner gives a power its role lacks while making the key, to this agent alone', !!extra && beyondKey.status === 201
      && beyondKey.body.data.key.scopes.join() === extra && beyondKey.body.data.key.scopes_given.join() === extra && await grantRows() === 1 && heldAfter.includes(extra),
    { extra, body: beyondKey.body, heldAfter });
    const neverKey = await session(agentKeysRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys`, { id: jeffId }, { scopes: ['tasks.read', 'audit.export'] });
    check('keys: a scope no agent key carries is refused, and nothing is given', neverKey.status === 422 && reason(neverKey) === 'scope_never_for_agents'
      && await count("SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'audit.export'", [jeffId]) === 0, neverKey.body);
    await session(agentRevokeRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys/${beyondKey.body?.data?.key?.id}/revoke`, { id: jeffId, keyId: beyondKey.body?.data?.key?.id });
    await s.q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = $2 AND access_channel = 'api'", [jeffId, extra]);
    const mcpAdd = await runTool(contextSecret, jeffId, 'add_project_context', { project_id: s.apex, category: 'lesson_learned', content: 'Deploys broke the checkout twice; deploy behind a flag.' });
    check('compat: add_project_context over MCP records an agent\'s entry with the same columns', mcpAdd?.ok === true && mcpAdd.data.source === 'agent'
      && JSON.stringify(Object.keys(mcpAdd.data)) === JSON.stringify(LEGACY_CONTEXT_KEYS), mcpAdd);
    const revoked = await session(agentRevokeRoute.POST, 'POST', `/api/workspace/agents/${jeffId}/keys/${contextKey.body.data.key.id}/revoke`, { id: jeffId, keyId: contextKey.body.data.key.id });
    check('keys: revoked from the screens', revoked.status === 200 && revoked.body.data.revoked[0] === contextKey.body.data.key.id
      && (await resolveApiKey(contextSecret).then(() => 'alive', () => 'revoked')) === 'revoked', revoked.body);
    const pinnedEntry = await session(briefRoute.POST, 'POST', `/api/workspace/projects/${s.apex}/brief`, { id: s.apex }, { section: 'links', content: 'Repo: https://github.com/acme/site. Deploy docs in the wiki.', pinned: true });
    check('brief: an entry by section gets its section\'s category', pinnedEntry.status === 201 && pinnedEntry.body.data.section === 'links'
      && pinnedEntry.body.data.category === 'business_context' && pinnedEntry.body.data.pinned === true, pinnedEntry.body);
    await session(briefRoute.POST, 'POST', `/api/workspace/projects/${s.apex}/brief`, { id: s.apex }, { section: 'rules', content: 'Never touch the billing tables without a person.', pinned: true });
    const brief = await session(briefRoute.GET, 'GET', `/api/workspace/projects/${s.apex}/brief`, { id: s.apex });
    const sections = brief.body?.data?.sections ?? [];
    const rules = sections.find((sec: Loose) => sec.key === 'rules');
    check('brief: sections in order, mapped from categories', JSON.stringify(sections.map((sec: Loose) => sec.key)) === JSON.stringify(['overview', 'rules', 'decisions', 'links', 'glossary', 'history'])
      && rules?.total === 2 && sections.find((sec: Loose) => sec.key === 'history')?.entries?.[0]?.source === 'agent', sections);
    check('brief: pinned first within a section', rules?.entries?.[0]?.pinned === true && rules.entries[1].pinned === false, rules);
    const pinnedId = pinnedEntry.body.data.id;
    const unpin = await session(briefEntryRoute.PATCH, 'PATCH', `/api/workspace/projects/${s.apex}/brief/${pinnedId}`, { id: s.apex, entryId: pinnedId }, { section: 'glossary' });
    check('brief: an entry moves section', unpin.body?.data?.section === 'glossary' && unpin.body.data.category === 'business_context', unpin.body);
    await session(briefEntryRoute.PATCH, 'PATCH', `/api/workspace/projects/${s.apex}/brief/${pinnedId}`, { id: s.apex, entryId: pinnedId }, { section: 'links' });
    const search = await session(briefSearchRoute.GET, 'GET', `/api/workspace/projects/${s.apex}/brief/search?q=deploy`, { id: s.apex });
    const hits = search.body?.data?.entries ?? [];
    check('brief: search ranks the best match first', hits.length === 3 && hits[0].content.startsWith('Deploys broke') && hits.every((h: Loose) => typeof h.rank === 'number')
      && hits[0].rank >= hits[1].rank, hits);
    const v1Search = await v1(v1ContextSearch.GET, 'GET', `/api/v1/projects/${s.apex}/context/search?q=billing`, { id: s.apex }, secret);
    check('brief: search_project_context over v1', v1Search.status === 200 && v1Search.body.data.length === 1, v1Search.body);
    as(LOGINS.mia);
    const miaBrief = await session(briefRoute.POST, 'POST', `/api/workspace/projects/${s.apex}/brief`, { id: s.apex }, { section: 'rules', content: 'x' });
    check('brief: writing needs project_context.manage', miaBrief.status === 403, miaBrief.body);
    as(LOGINS.owner);
    const removed = await session(briefEntryRoute.DELETE, 'DELETE', `/api/workspace/projects/${s.apex}/brief/${legacyAdd.body.data.id}`, { id: s.apex, entryId: legacyAdd.body.data.id });
    check('brief: removing archives (is_active false), as the API always has', removed.status === 200
      && (await s.q<Loose>('SELECT is_active FROM pm.project_context WHERE id = $1', [legacyAdd.body.data.id]))[0].is_active === false);

    // get_project_context answers exactly its nine columns, as select('*') did before the update.
    const legacyRead = await v1(v1Context.GET, 'GET', `/api/v1/projects/${s.apex}/context`, { id: s.apex }, s.keys.owner);
    const star = (await service.from('project_context').select('*').eq('project_id', s.apex).eq('is_active', true).order('category').order('created_at')).data as Loose[];
    const asBefore = star.map((row) => Object.fromEntries(LEGACY_CONTEXT_KEYS.map((key) => [key, row[key]])));
    check('compat: get_project_context answers what it always did, byte for byte', JSON.stringify(legacyRead.body?.data) === JSON.stringify(asBefore), { got: legacyRead.body?.data?.[0], want: asBefore[0] });
    const mcpGet = await runTool(s.keys.owner, s.owner, 'get_project_context', { project_id: s.apex });
    check('compat: and over MCP', JSON.stringify(mcpGet?.data) === JSON.stringify(asBefore), mcpGet);
    const pinnedOnly = await runTool(s.keys.owner, s.owner, 'get_project_context', { project_id: s.apex, pinned: true });
    const bySection = await runTool(s.keys.owner, s.owner, 'get_project_context', { project_id: s.apex, section: 'links' });
    check('compat: section and pinned filters are additive', pinnedOnly?.data?.length === 2 && bySection?.data?.length === 1, { pinnedOnly, bySection });

    // --- Context pack and task brief -------------------------------------------------
    const pack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context', {}, secret);
    const p = pack.body?.data?.pack;
    const apexInPack = p?.assignments?.list?.find((a: Loose) => a.project.id === s.apex);
    check('pack: its role label, description and owners', p?.member?.agent_role === 'code-builder' && p?.member?.description === 'Builds the site.' && p?.owners?.length === 2, p?.member);
    check('pack: its assignment with settings, instructions and pinned entries', apexInPack?.instructions?.includes('Ask before') && apexInPack?.settings?.repository_url
      && apexInPack?.pinned?.length === 2, apexInPack);
    check('pack: the Markdown says its role and its projects', /Your role: code-builder\./.test(pack.body?.data?.markdown) && /## Your projects/.test(pack.body?.data?.markdown)
      && /Ask before migrations/.test(pack.body?.data?.markdown), pack.body?.data?.markdown?.slice(0, 800));
    check('pack: another agent\'s instructions are not in it', !pack.text.includes('Ada only'));
    const adaPack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context', {}, adaSecret);
    check('pack: each agent carries its own instructions', adaPack.text.includes('Ada only') && !adaPack.text.includes('Ask before migrations'));
    const screenPack = await session(agentContextRoute.GET, 'GET', `/api/workspace/agents/${jeffId}/context?format=md`, { id: jeffId });
    check('pack: the screens read it as an AGENTS.md', screenPack.status === 200 && /# Jeff B/.test(screenPack.text) && screenPack.headers.get('cache-control') === 'no-store', screenPack.text.slice(0, 200));
    const exported = await v1(v1Export.GET, 'GET', `/api/v1/agents/${jeffId}/export`, { id: jeffId }, s.keys.owner);
    check('export: role label, description and owners', exported.body?.data?.member?.agent_role === 'code-builder' && exported.body.data.owners.length === 2, exported.body?.data?.member);
    const setupRead = await v1(v1Setup2.GET, 'GET', `/api/v1/agents/${jeffId}/setup`, { id: jeffId }, s.keys.owner);
    check('get_agent_setup: role label and owners', setupRead.body?.data?.member?.agent_role === 'code-builder' && setupRead.body.data.owners.length === 2, setupRead.body?.data?.member);

    const taskId = (await s.q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [s.apex, 'Build the pricing page']))[0].id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [taskId, jeffId]);
    const taskBrief = await v1(v1Brief.GET, 'GET', `/api/v1/tasks/${taskId}/brief`, { id: taskId }, secret);
    const tb = taskBrief.body?.data;
    check('task brief: the caller\'s assignment on the task\'s project', tb?.assignment?.instructions?.includes('Ask before') && tb?.assignment?.settings?.working_branch === 'dev', tb?.assignment);
    check('task brief: pinned entries first, each with its section', tb?.project_context?.entries?.[0]?.pinned === true && tb.project_context.entries[1].pinned === true
      && typeof tb.project_context.entries[0].section === 'string', tb?.project_context);
    const adaTask = (await s.q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [s.apex, 'Weekly report']))[0].id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [adaTask, adaId]);
    const adaBrief = await v1(v1Brief.GET, 'GET', `/api/v1/tasks/${adaTask}/brief`, { id: adaTask }, adaSecret);
    check('task brief: only its own instructions', adaBrief.body?.data?.assignment?.instructions?.includes('Ada only') && !adaBrief.text.includes('Ask before migrations'), adaBrief.body?.data?.assignment);
    const personBrief = await v1(v1Brief.GET, 'GET', `/api/v1/tasks/${taskId}/brief`, { id: taskId }, s.keys.owner);
    check('task brief: a person gets no assignment', personBrief.status === 200 && personBrief.body.data.assignment === null);

    // --- Project setup ----------------------------------------------------------------
    const projects = () => count('SELECT count(*)::int AS n FROM pm.projects');
    const projectsBefore = await projects();
    as(LOGINS.morgan);
    const morganSetup = await session(setupRoute.POST, 'POST', '/api/workspace/projects/setup', {}, { project: { name: 'Nope' } });
    check('setup: needs projects.manage', morganSetup.status === 403, morganSetup.body);
    as(LOGINS.owner);
    const noBrief = await v1(v1Setup.POST, 'POST', '/api/v1/projects/setup', {}, s.keys.ownerNoBrief, { project: { name: 'Half' }, brief: [{ section: 'overview', content: 'x' }] });
    check('setup: a part the key may not write is refused before anything is made', noBrief.status === 403 && noBrief.body.error.details.part === 'brief' && await projects() === projectsBefore, noBrief.body);
    const badAgent = await session(setupRoute.POST, 'POST', '/api/workspace/projects/setup', {}, { project: { name: 'Bad' }, agents: [{ agent_id: jeffId, settings: { nope: 1 } }] });
    check('setup: agent settings are checked before anything is made', badAgent.status === 422 && await projects() === projectsBefore, badAgent.body);
    const setup = await session(setupRoute.POST, 'POST', '/api/workspace/projects/setup', {}, {
      project: { name: 'Launch', description: 'The launch site' },
      members: [s.morgan],
      brief: [{ section: 'overview', content: 'A launch site for the spring campaign.' }, { section: 'rules', content: 'No tracking scripts.', pinned: true }],
      goals: [{ title: 'Live by March' }],
      agents: [{ agent_id: jeffId, template_key: 'builder', settings: { repository_url: 'https://github.com/acme/launch' }, instructions: 'Static pages only.' }],
    });
    const made = setup.body?.data;
    const launchId = made?.project?.id;
    check('setup: one call makes the project, brief, goals and assignments', setup.status === 201 && made?.brief?.length === 2 && made?.goals?.length === 1
      && made?.assignments?.[0]?.settings?.repository_url === 'https://github.com/acme/launch' && made.assignments[0].settings.protected_branch === 'main', setup.body);
    check('setup: members and the agent get project access', await count('SELECT count(*)::int AS n FROM pm.project_members WHERE project_id = $1 AND member_id = ANY($2)', [launchId, [s.morgan, jeffId]]) === 2);
    const failedSetup = await session(setupRoute.POST, 'POST', '/api/workspace/projects/setup', {}, {
      project: { name: 'Doomed' }, brief: [{ section: 'overview', content: 'x' }], agents: [{ agent_id: adaId, instructions: 'FAIL' }],
    });
    const doomed = failedSetup.body?.error?.details?.project_id;
    check('setup: a failure partway moves the project to Trash and says so', failedSetup.status >= 500 && reason(failedSetup) === 'setup_incomplete'
      && (await s.q<Loose>('SELECT deleted_at FROM pm.projects WHERE id = $1', [doomed]))[0]?.deleted_at !== null, failedSetup.body);
    const v1Made = await v1(v1Setup.POST, 'POST', '/api/v1/projects/setup', {}, s.keys.owner, { project: { name: 'From chat' }, goals: [{ title: 'One' }] });
    check('setup: over v1', v1Made.status === 201 && v1Made.body.data.goals.length === 1, v1Made.body);
    const mcpMade = await runTool(s.keys.owner, s.owner, 'setup_project', { project: { name: 'From MCP' }, brief: [{ section: 'glossary', content: 'SKU: a product variant.' }] });
    check('setup: setup_project over MCP', mcpMade?.ok === true && mcpMade.data.brief[0].section === 'glossary', mcpMade);
    const plainCreate = await session(workspaceProjectsRoute.POST, 'POST', '/api/workspace/projects', {}, { name: 'Plain' });
    check('setup: the screens\' own create still works', plainCreate.status === 201 && plainCreate.body.data.name === 'Plain', plainCreate.body);
    await db.exec('RESET ROLE');
    await db.exec('DROP TRIGGER test_fail_assignment ON pm.project_agents; DROP FUNCTION pm.test_fail_assignment();');

    // --- MCP visibility -----------------------------------------------------------------
    const visible = async (apiKey: string) => {
      const { access, keyRow } = await resolveApiKey(apiKey);
      return toolsFor({ access, scopes: keyRow.scopes ?? [], readOnly: keyRow.permissions === 'read_only', profile: 'generic' }).map((t) => t.name);
    };
    const ownerTools = await visible(s.keys.owner);
    const agentTools = await visible(secret);
    const newSetup = ['list_agents', 'update_agent', 'set_project_agent', 'remove_project_agent', 'setup_project'];
    check('MCP: the new setup tools are setup tools, seen by an Owner key, not an agent\'s', newSetup.every((name) => SETUP_TOOLS.includes(name) && ownerTools.includes(name))
      && !newSetup.some((name) => agentTools.includes(name)), { ownerTools, agentTools });
    check('MCP: an agent sees list_my_projects and search_project_context', agentTools.includes('list_my_projects') && agentTools.includes('search_project_context'), agentTools);

    // --- Templates of many agents, in one batched read ---------------------------------
    const { appliedTemplateKeys } = await import('../src/lib/api/agent-context');
    const many = (await s.q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role)
      SELECT 'Templated ' || lpad(n::text, 3, '0'), 'templated' || n || '@agents.example.com', 'agent' FROM generate_series(1, 250) n RETURNING id`)).map((row) => row.id);
    const keyOf = (index: number) => (['builder', 'weekly-reporter', 'data-health-watcher'])[index % 3];
    await s.q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code)
      SELECT 'POST', '/api/v1/agents/' || id || '/template', 'team_member', id, jsonb_build_object('template', t), 200
      FROM unnest($1::uuid[], $2::text[]) AS x(id, t)`, [many, many.map((_, index) => keyOf(index))]);
    // A newer hire with no template, and an older import naming another, change nothing for the first agent.
    await s.q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code, timestamp)
      VALUES ('POST', '/api/v1/agents/import', 'team_member', $1, '{"template":"inbox-triage"}', 200, now() - interval '1 day'),
             ('POST', '/api/workspace/agents', 'team_member', $1, '{"template":null}', 201, now() + interval '1 minute')`, [many[0]]);
    const applied = await appliedTemplateKeys(service, many);
    const wrong = many.filter((id, index) => applied.get(id) !== keyOf(index));
    check('templates: every one of 250 agents reads its own template', wrong.length === 0, { wrong: wrong.length, read: applied.size });
    const roster = await session(hireRoute.GET, 'GET', '/api/workspace/agents?limit=200&search=Templated', {});
    const rosterWrong = (roster.body?.data?.agents ?? []).filter((agent: Loose) => agent.template_key !== keyOf(many.indexOf(agent.id)));
    check('templates: a roster page of 200 shows every template', roster.body?.data?.agents?.length === 200 && rosterWrong.length === 0, { n: roster.body?.data?.agents?.length, wrong: rosterWrong.length });
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE name LIKE 'Templated %'");

    // Project access past the 1000-row cap a response has (Supabase's db-max-rows, which the fake keeps).
    await s.q("INSERT INTO pm.projects (name) SELECT 'Access project ' || n FROM generate_series(1, 6) n");
    await s.q(`INSERT INTO pm.team_members (name, email, role)
      SELECT 'Access agent ' || lpad(n::text, 3, '0'), 'access' || n || '@agents.example.com', 'agent' FROM generate_series(1, 200) n`);
    await s.q(`INSERT INTO pm.project_members (project_id, member_id)
      SELECT p.id, m.id FROM pm.projects p, pm.team_members m WHERE p.name LIKE 'Access project %' AND m.name LIKE 'Access agent %'`);
    check('access: 1200 membership rows to read', await count("SELECT count(*)::int AS n FROM pm.project_members pm2 JOIN pm.team_members m ON m.id = pm2.member_id WHERE m.name LIKE 'Access agent %'") === 1200);
    const accessPage = await session(hireRoute.GET, 'GET', '/api/workspace/agents?limit=200&search=Access%20agent', {});
    const undercounted = (accessPage.body?.data?.agents ?? []).filter((agent: Loose) => agent.access_total !== 6 || agent.access_project_ids?.length !== 6);
    check('access: 200 agents on 6 projects each all count 6, past the row cap', accessPage.body?.data?.agents?.length === 200 && undercounted.length === 0,
      { n: accessPage.body?.data?.agents?.length, undercounted: undercounted.length });
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE name LIKE 'Access agent %'");

    // --- Scale ----------------------------------------------------------------------------
    await s.q(`INSERT INTO pm.team_members (name, email, role, agent_role)
      SELECT 'Scale agent ' || lpad(n::text, 3, '0'), 'scale' || n || '@agents.example.com', 'agent', CASE WHEN n % 2 = 0 THEN 'worker' ELSE 'checker' END
      FROM generate_series(1, 100) n`);
    await s.q(`INSERT INTO pm.projects (name) SELECT 'Scale project ' || n FROM generate_series(1, 100) n`);
    await s.q(`INSERT INTO pm.project_agents (project_id, agent_id, instructions)
      SELECT p.id, $1, repeat('Instructions for this project. ', 60) FROM pm.projects p WHERE p.name LIKE 'Scale project %'`, [jeffId]);
    await s.q(`INSERT INTO pm.project_members (project_id, member_id) SELECT p.id, $1 FROM pm.projects p WHERE p.name LIKE 'Scale project %' ON CONFLICT DO NOTHING`, [jeffId]);
    await s.q(`INSERT INTO pm.project_context (project_id, category, content, pinned)
      SELECT $1, (ARRAY['business_context','existing_work','technical_decision','constraint','lesson_learned'])[1 + n % 5],
        'Scale entry ' || n || ' about ' || (ARRAY['checkout','search','billing','deploys','emails'])[1 + n % 5] || '. ' || repeat('More words here. ', 40), n % 50 = 0
      FROM generate_series(1, 1000) n`, [s.apex]);
    for (const project of (await s.q<{ id: string }>("SELECT id FROM pm.projects WHERE name LIKE 'Scale project %' LIMIT 40"))) {
      await s.q("INSERT INTO pm.project_context (project_id, category, content, pinned) SELECT $1, 'constraint', 'Pinned rule ' || n || ' ' || repeat('long text ', 80), true FROM generate_series(1, 6) n", [project.id]);
    }

    let started = Date.now();
    const bigList = await session(hireRoute.GET, 'GET', '/api/workspace/agents?limit=200', {});
    const listMs = Date.now() - started;
    check('scale: the agent list is one page, bounded', bigList.status === 200 && bigList.body.data.agents.length <= 200 && bigList.body.data.meta.total >= 103, bigList.body?.data?.meta);
    check('scale: and quick (a fixed number of reads)', listMs < 15_000, listMs);
    const paged = await session(hireRoute.GET, 'GET', '/api/workspace/agents?limit=25&page=2&role=worker', {});
    check('scale: paged and filtered by role', paged.body?.data?.agents?.length === 25 && paged.body.data.meta.total === 50 && paged.body.data.agents.every((a: Loose) => a.agent_role === 'worker'), paged.body?.data?.meta);
    started = Date.now();
    const bigPack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, secret);
    const bp = bigPack.body?.data?.pack;
    check('scale: the pack of an agent on 100+ projects stays within its cap', bigPack.status === 200 && JSON.stringify(bp).length <= PACK_LIMITS.total
      && bp.assignments.list.length <= PACK_LIMITS.assignments && bp.assignments.list.length + bp.assignments.more >= 100, { size: JSON.stringify(bp ?? {}).length, cut: bp?.cut_to_fit, n: bp?.assignments?.list?.length });
    check('scale: pack time sanity', Date.now() - started < 15_000);
    const bigBrief = await v1(v1Brief.GET, 'GET', `/api/v1/tasks/${taskId}/brief`, { id: taskId }, secret);
    const bb = bigBrief.body?.data;
    check('scale: the task brief over 1000 entries stays within its cap, flagged', bigBrief.status === 200 && bigBrief.text.length <= BRIEF_LIMITS.total + 200
      && bb.project_context.entries.length <= BRIEF_LIMITS.contextEntries && bb.project_context.truncated === true && bb.project_context.total >= 1000
      && bb.project_context.entries[0].pinned === true && /search_project_context/.test(bb.project_context.note), { size: bigBrief.text.length, total: bb?.project_context?.total });
    const bigProjectBrief = await session(briefRoute.GET, 'GET', `/api/workspace/projects/${s.apex}/brief`, { id: s.apex });
    const totals = (bigProjectBrief.body?.data?.sections ?? []).reduce((sum: number, sec: Loose) => sum + sec.total, 0);
    check('scale: the brief answers each section\'s first page and every total', bigProjectBrief.body?.data?.sections?.every((sec: Loose) => sec.entries.length <= 50) && totals >= 1000, totals);
    const rulesPage = await session(briefRoute.GET, 'GET', `/api/workspace/projects/${s.apex}/brief?section=rules&page=2&limit=50`, { id: s.apex });
    check('scale: one section pages', rulesPage.body?.data?.sections?.length === 1 && rulesPage.body.data.sections[0].entries.length === 50, rulesPage.body?.data?.sections?.[0]?.total);
    const scaleSearch = await v1(v1ContextSearch.GET, 'GET', `/api/v1/projects/${s.apex}/context/search?q=checkout&limit=50`, { id: s.apex }, s.keys.owner);
    check('scale: search answers at most 50', scaleSearch.body?.data?.length === 50, scaleSearch.body?.data?.length);
    const projectPage = await v1(v1ProjectAgents.GET, 'GET', `/api/v1/projects/${s.apex}/agents?limit=1`, { id: s.apex }, s.keys.owner);
    check('scale: project agents page', projectPage.body?.data?.length === 1 && projectPage.body.meta.total === 2, projectPage.body?.meta);
    const myPage = await v1(v1MyProjects.GET, 'GET', '/api/v1/agents/me/projects?limit=10', {}, secret);
    check('scale: my projects page', myPage.body?.data?.length === 10 && myPage.body.meta.total >= 100, myPage.body?.meta);

    // The reads use their indexes (the planner may prefer a scan on tiny tables, so scans are discouraged here).
    await db.exec('RESET ROLE');
    await db.exec('SET enable_seqscan = off');
    const plan = async (sql: string, params: unknown[] = []) => (await db.query<Loose>(`EXPLAIN ${sql}`, params)).rows.map((row) => row['QUERY PLAN']).join('\n');
    const searchPlan = await plan("SELECT c.id FROM pm.project_context c WHERE c.project_id = $1 AND c.is_active AND to_tsvector('english'::regconfig, c.content) @@ websearch_to_tsquery('english'::regconfig, 'checkout')", [s.apex]);
    check('index: search', /idx_project_context_(search|brief)/.test(searchPlan), searchPlan);
    const briefPlan = await plan('SELECT id FROM pm.project_context WHERE project_id = $1 AND section = \'rules\' AND is_active ORDER BY pinned DESC, updated_at DESC LIMIT 50', [s.apex]);
    check('index: a brief section', /idx_project_context_brief/.test(briefPlan), briefPlan);
    const ownerPlan = await plan('SELECT agent_id FROM pm.agent_owners WHERE member_id = $1', [s.morgan]);
    check('index: agents by owner', /idx_agent_owners_member/.test(ownerPlan), ownerPlan);
    const assignPlan = await plan('SELECT id FROM pm.project_agents WHERE agent_id = $1', [jeffId]);
    check('index: assignments by agent', /idx_project_agents_agent/.test(assignPlan), assignPlan);
    const rolePlan = await plan("SELECT id FROM pm.team_members WHERE agent_role = 'worker'");
    check('index: agents by role', /idx_team_members_agent_role/.test(rolePlan), rolePlan);
    await db.exec('SET enable_seqscan = on');
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent workspaces: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`agent workspaces: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
