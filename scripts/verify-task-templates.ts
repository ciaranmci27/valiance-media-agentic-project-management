/**
 * Task templates (20261125000300_task_templates.sql), over the real routes
 * and services (session routes with a signed-in member, v1 routes with keys,
 * MCP tools through routeCaller, a fake PostgREST over PGlite with the full
 * schema):
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   the version follows what a template makes; templates and runs are never
 *   permanently deleted; Admins hold templates.manage by default.
 * - A playbook with subtasks and due dates counted from the start date
 *   creates exactly the right tasks, through the task service (activity and
 *   the task.created webhook follow), with "runner" assigned to whoever uses
 *   it and named people kept.
 * - Fill-in fields replace {key} in titles and descriptions; a missing value
 *   and an undeclared fill-in are refused.
 * - A template locked to a project creates only there and is hidden from
 *   whoever cannot open that project.
 * - Permissions: managing needs templates.manage, using needs tasks.create,
 *   a key needs the scope; nothing is made when refused.
 * - Every use records a run (version, snapshot, values, task ids) and sends
 *   template.run; the library counts uses.
 * - Trash hides a template everywhere; its tasks and runs stay.
 *
 *   npm run -s test:task-templates
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
import {
  addDays, fillIn, isCalendarDate, keyFromLabel, labelForKey, planRun, syncFields, taskCount, templateSizeLabel, type TemplateTask,
} from '../src/lib/task-templates';
import { PERMISSION_MODULE } from '../src/lib/modules/registry';
import { API_ENDPOINT_PERMISSIONS } from '../src/lib/access-control';

const MIGRATION = '20261125000300_task_templates.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- TASK TEMPLATES (20261125000300_task_templates.sql)';

let passed = 0;
/** How long the 200-task use took, reported with the result. */
let bigRunMs = 0;
let bigRunRequests = 0;
/** Requests the fake PostgREST served, to count round trips. */
let requests = 0;
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
  owner: { id: id(1101), email: 'olivia@studio.example' },
  admin: { id: id(1102), email: 'adam@studio.example' },
  morgan: { id: id(1103), email: 'morgan@studio.example' },
  nina: { id: id(1104), email: 'nina@studio.example' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    requests++;
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
  const runner = id(9001);
  const named = id(9002);
  const playbook: TemplateTask[] = [
    {
      title: 'Write the {product} launch brief', description: 'Brief for {product}, owned by {owner_name}.', priority: 'high', tags: ['launch'], assignee: 'runner', due_in_days: 2,
      subtasks: [{ title: 'Agree the {product} launch date', description: '', priority: 'medium', tags: [], assignee: named, due_in_days: 1 }],
    },
    { title: 'Launch {product}', description: '', priority: 'urgent', tags: [], assignee: null, due_in_days: null, subtasks: [] },
  ];
  const plan = planRun(playbook, { startDate: '2026-12-30', values: { product: 'Aurora', owner_name: 'Ana' }, runnerId: runner });
  check('plan: fill-ins replaced in titles and descriptions', plan[0].title === 'Write the Aurora launch brief' && plan[0].description === 'Brief for Aurora, owned by Ana.'
    && plan[0].subtasks[0].title === 'Agree the Aurora launch date', plan);
  check('plan: due dates count from the start date, across a year end', plan[0].due_date === '2027-01-01' && plan[0].subtasks[0].due_date === '2026-12-31' && plan[1].due_date === null, plan.map((t) => t.due_date));
  check('plan: runner is whoever uses it; a named person stays; nobody is nobody', plan[0].assignee_id === runner && plan[0].subtasks[0].assignee_id === named && plan[1].assignee_id === null);
  check('dates: calendar arithmetic, leap day included', addDays('2028-02-28', 1) === '2028-02-29' && addDays('2026-03-08', 0) === '2026-03-08' && isCalendarDate('2027-02-29') === false && isCalendarDate('2028-02-29'));
  check('fill-in: an undeclared key stays as written', fillIn('Hello {client} and {other}', { client: 'Acme' }) === 'Hello Acme and {other}');
  check('fields: kept in step with the fill-ins, labels kept', JSON.stringify(syncFields([{ key: 'product', label: 'Product name' }, { key: 'gone', label: 'Gone' }], playbook))
    === JSON.stringify([{ key: 'product', label: 'Product name' }, { key: 'owner_name', label: 'Owner name' }]));
  check('labels and keys', labelForKey('client_name') === 'Client name' && keyFromLabel('Client name!') === 'client_name' && keyFromLabel('2nd step') === 'nd_step');
  check('size: counts subtasks', taskCount(playbook) === 3 && templateSizeLabel({ item_count: 2, task_count: 3 }) === 'Playbook, 3 tasks'
    && templateSizeLabel({ item_count: 1, task_count: 1 }) === '1 task' && templateSizeLabel({ item_count: 1, task_count: 3 }) === '1 task, 2 subtasks');
  check('registry: templates.manage is core and an API scope', PERMISSION_MODULE['templates.manage'] === 'core' && (API_ENDPOINT_PERMISSIONS as readonly string[]).includes('templates.manage'));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  // Later releases add their own sections after this one (GOOGLE SIGN-IN first).
  const next = SCHEMA_SQL.indexOf('\n-- ====', SCHEMA_SQL.indexOf('\n-- ====', at) + 1);
  const section = next > 0 ? SCHEMA_SQL.slice(at, next) : SCHEMA_SQL.slice(at);
  check('schema.sql: the task templates section is there, after FOLLOW-UPS', at > 0 && banner > 0 && section.split('\n-- ====').length === 2
    && SCHEMA_SQL.indexOf('-- FOLLOW-UPS (20261125000200_followups.sql)') < at);
  // The Trash functions are edited in place where Trash is defined; the rest is the section.
  const trashAt = MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Trash: templates join');
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Templates'), trashAt).trim();
  check('schema.sql: the section mirrors the migration body', trashAt > 0 && section.includes(body));
  const trigger = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('DROP TRIGGER IF EXISTS record_trash_event ON pm.task_templates')).trim();
  check('schema.sql: the section ends with the Trash ping', section.trim().endsWith(trigger));
  for (const fn of ['trash_record_types', 'can_trash_record', 'trash_restore_blocker', 'trash_entity_type', 'list_trash']) {
    const head = `CREATE OR REPLACE FUNCTION pm.${fn}(`;
    const inMigration = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf(head), MIGRATION_SQL.indexOf('\n$$;', MIGRATION_SQL.indexOf(head)));
    const inSchema = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf(head), SCHEMA_SQL.indexOf('\n$$;', SCHEMA_SQL.indexOf(head)));
    check(`schema.sql: ${fn} is defined once, edited in place as the migration has it`, inMigration.includes('task_templates') && inMigration === inSchema
      && SCHEMA_SQL.split(head).length === 2, fn);
  }

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();

  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => fresh.query(sql, params).then(() => null, (e: Error) => e.message);
  const admin = (await q("SELECT count(*)::int AS n FROM pm.role_permissions WHERE role = 'admin' AND permission_key = 'templates.manage'"))[0].n;
  const member = (await q("SELECT count(*)::int AS n FROM pm.role_permissions WHERE role = 'member' AND permission_key = 'templates.manage'"))[0].n;
  check('defaults: Admins manage templates on the app and the API; members do not', admin === 2 && member === 0, { admin, member });
  const tpl = (await q<{ id: string; version: number }>(`INSERT INTO pm.task_templates (name, items, version) VALUES ('  Payroll  ', '[{"title":"Upload"}]', 9) RETURNING id, version`))[0];
  const named = (await q<{ name: string }>('SELECT name FROM pm.task_templates WHERE id = $1', [tpl.id]))[0];
  check('database: a new template starts at version 1, its name trimmed', tpl.version === 1 && named.name === 'Payroll', { tpl, named });
  await q("UPDATE pm.task_templates SET items = '[{\"title\":\"Upload the sheet\"}]' WHERE id = $1", [tpl.id]);
  await q("UPDATE pm.task_templates SET updated_by = NULL WHERE id = $1", [tpl.id]);
  const bumped = (await q<{ version: number }>('SELECT version FROM pm.task_templates WHERE id = $1', [tpl.id]))[0].version;
  check('database: the version goes up when what it makes changes, not otherwise', bumped === 2, bumped);
  check('database: a template is never permanently deleted', (await fail('DELETE FROM pm.task_templates WHERE id = $1', [tpl.id])) !== null);
  check('database: items must be a list', /task_templates_items_shape/.test(await fail(`INSERT INTO pm.task_templates (name, items) VALUES ('Bad', '{}')`) ?? ''));
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
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const admin = await member('Adam', 'admin', LOGINS.admin);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const nina = await member('Nina', 'member', LOGINS.nina);
  const sam = await member('Sam', 'member');
  // Nina may read but not create tasks.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'tasks.create', 'app', 'deny'), ($1, 'tasks.create', 'api', 'deny') ON CONFLICT DO NOTHING", [nina]);
  const project = async (name: string, members: string[]) => {
    const projectId = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [projectId, m]);
    return projectId;
  };
  // Morgan and Nina work on Launches; only Olivia and Sam on Payroll.
  const launches = await project('Launches', [morgan, nina]);
  const payroll = await project('Payroll', [sam]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['templates.manage', 'tasks.create', 'tasks.read', 'projects.read', 'projects.read_all']),
    ownerNoManage: await key(owner, ['tasks.create', 'tasks.read', 'projects.read']),
    morgan: await key(morgan, ['tasks.create', 'tasks.read', 'projects.read']),
    morganReadOnly: await key(morgan, ['tasks.read', 'projects.read']),
  };
  // Agents under rules: one whose new tasks need approval, one paused on
  // Launches, and Morgan's personal assistant with Create tasks for me off.
  const agent = async (name: string, extra: Record<string, unknown> = {}) => {
    const cols = Object.keys(extra);
    const agentId = (await q<{ id: string }>(
      `INSERT INTO pm.team_members (name, email, role${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, 'agent'${cols.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
      [name, `${name.toLowerCase()}@agents.invalid`, ...Object.values(extra)]))[0].id;
    for (const permission of ['tasks.create', 'tasks.read', 'projects.read']) {
      await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [agentId, permission]);
    }
    await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [launches, agentId]);
    return agentId;
  };
  const careful = await agent('Careful', { agent_create_policy: 'approval' });
  const resting = await agent('Resting');
  await q("INSERT INTO pm.project_agents (project_id, agent_id, status) VALUES ($1, $2, 'paused')", [launches, resting]);
  const helper = await agent('Helper', { delegate_of: morgan, assistant_template: 'personal-assistant' });
  await q(`INSERT INTO pm.assistant_preferences (agent_id, switches) VALUES ($1, '{"create_tasks": false}')`, [helper]);
  const agentScopes = ['tasks.create', 'tasks.read', 'projects.read'];
  const agentKeys = { careful: await key(careful, agentScopes), resting: await key(resting, agentScopes), helper: await key(helper, agentScopes) };
  // A harness listening for template uses.
  await q("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Harness', 'https://hooks.example/pm', 'whsec_test', ARRAY['template.run', 'task.created'])");
  return { q, owner, admin, morgan, nina, sam, launches, payroll, keys, agentKeys };
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
  try {
    const listRoute = await import('../src/app/api/workspace/task-templates/route');
    const oneRoute = await import('../src/app/api/workspace/task-templates/[id]/route');
    const runRoute = await import('../src/app/api/workspace/task-templates/[id]/run/route');
    const runsRoute = await import('../src/app/api/workspace/task-templates/[id]/runs/route');
    const v1List = await import('../src/app/api/v1/task-templates/route');
    const v1One = await import('../src/app/api/v1/task-templates/[id]/route');
    const v1Run = await import('../src/app/api/v1/task-templates/[id]/run/route');
    const v1Runs = await import('../src/app/api/v1/task-templates/[id]/runs/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
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
    const tasksBefore = await count('SELECT count(*)::int AS n FROM pm.tasks');

    // ── Managing: templates.manage ─────────────────────────────────────
    const launchBody = {
      name: 'Product launch',
      description: 'Everything a launch needs.',
      fields: [{ key: 'product', label: 'Product' }],
      items: [
        {
          title: 'Write the {product} launch brief', description: 'Who {product} is for and what is new.', priority: 'high', tags: ['launch'], assignee: 'runner', due_in_days: 2,
          subtasks: [
            { title: 'Agree the {product} launch date', assignee: s.morgan, due_in_days: 1 },
            { title: 'List who needs to know', due_in_days: 2 },
          ],
        },
        { title: 'Design the {product} launch assets', assignee: s.sam, due_in_days: 7 },
        { title: 'Launch {product}', priority: 'urgent', due_in_days: 21 },
      ],
    };
    as(LOGINS.morgan);
    const refusedCreate = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, launchBody);
    check('permissions: a member without templates.manage cannot create one', refusedCreate.status === 403 && reason(refusedCreate) === 'missing_permission'
      && await count('SELECT count(*)::int AS n FROM pm.task_templates') === 0, refusedCreate.body);
    as(LOGINS.admin);
    const created = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, launchBody);
    const launchId = created.body?.data?.id as string;
    check('manage: an Admin creates a playbook (by default), the creator recorded', created.status === 201 && created.body.data.task_count === 5 && created.body.data.item_count === 3
      && created.body.data.version === 1 && created.body.data.created_by === s.admin && created.body.data.created_by_name === 'Adam', created.body);
    const undeclared = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, { name: 'Oops', items: [{ title: 'Call {client}' }] });
    check('manage: a fill-in with no field is refused, naming it', undeclared.status === 422 && /\{client\}/.test(undeclared.body?.error?.message ?? ''), undeclared.body);
    as(LOGINS.owner);
    const payrollBody = {
      name: 'Monthly payroll upload', project_id: s.payroll, fields: [{ key: 'month', label: 'Month' }],
      items: [{ title: 'Upload the {month} payroll sheet', assignee: 'runner', due_in_days: 3, priority: 'high' }],
    };
    const payrollTpl = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, payrollBody);
    const payrollId = payrollTpl.body?.data?.id as string;
    check('manage: a template locked to a project names it', payrollTpl.status === 201 && payrollTpl.body.data.project_id === s.payroll && payrollTpl.body.data.project_name === 'Payroll', payrollTpl.body);
    const v1Refused = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.ownerNoManage, payrollBody);
    check('permissions: a key without the templates.manage scope is refused', v1Refused.status === 403 && reason(v1Refused) === 'missing_key_scope', v1Refused.body);

    // ── Reading: locked templates only where they can be opened ────────
    as(LOGINS.morgan);
    const morganList = await session(listRoute.GET, 'GET', '/api/workspace/task-templates');
    check('library: a member sees unlocked templates, not one locked to a project they cannot open', morganList.status === 200
      && morganList.body.data.templates.map((t: Loose) => t.id).join() === launchId && !('items' in morganList.body.data.templates[0]), morganList.body);
    const morganPayroll = await session(oneRoute.GET, 'GET', `/api/workspace/task-templates/${payrollId}`, { id: payrollId });
    check('library: a locked template out of reach reads as missing', morganPayroll.status === 404, morganPayroll.body);
    as(LOGINS.owner);
    const ownerFiltered = await session(listRoute.GET, 'GET', `/api/workspace/task-templates?project_id=${s.payroll}`);
    check('library: project_id lists the unlocked ones and the ones locked to it', ownerFiltered.body?.data?.templates?.length === 2, ownerFiltered.body);
    const ownerOther = await session(listRoute.GET, 'GET', `/api/workspace/task-templates?project_id=${s.launches}`);
    check('library: a template locked elsewhere is left out of another project', ownerOther.body?.data?.templates?.map((t: Loose) => t.id).join() === launchId, ownerOther.body);
    // Row security agrees for a signed-in browser read.
    await actAs(db, LOGINS.morgan.id);
    const rlsMorgan = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.task_templates')).rows[0].n;
    await actAs(db, null);
    await db.exec('RESET ROLE');
    check('policy: a member reads only the templates they could use', rlsMorgan === 1, rlsMorgan);

    // ── Using a playbook: subtasks and due dates ───────────────────────
    as(LOGINS.morgan);
    const missing = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.launches, start_date: '2026-12-01' });
    check('use: a missing fill-in is refused, naming the field, nothing made', missing.status === 422 && reason(missing) === 'missing_values'
      && missing.body.error.details.fields['values.product'] === 'Fill in Product.' && await count('SELECT count(*)::int AS n FROM pm.tasks') === tasksBefore, missing.body);
    const used = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId },
      { project_id: s.launches, start_date: '2026-12-01', values: { product: 'Aurora' } });
    const usedTasks = (used.body?.data?.tasks ?? []) as Loose[];
    check('use: answers 201 with every task made, subtasks after their parent', used.status === 201 && usedTasks.length === 5, used.body);
    const made = await s.q<Loose>(`SELECT t.id, t.title, t.description, t.priority, t.tags, t.status, left(t.due_date::text, 10) AS due, t.parent_task_id, t.project_id, t.created_by,
      coalesce((SELECT array_agg(a.member_id) FROM pm.task_assignees a WHERE a.task_id = t.id), '{}') AS assignees
      FROM pm.tasks t WHERE t.id = ANY($1::uuid[])`, [usedTasks.map((t) => t.id)]);
    const byTitle = new Map(made.map((t) => [t.title, t]));
    const brief = byTitle.get('Write the Aurora launch brief');
    const date = byTitle.get('Agree the Aurora launch date');
    const list = byTitle.get('List who needs to know');
    const design = byTitle.get('Design the Aurora launch assets');
    const launch = byTitle.get('Launch Aurora');
    check('playbook: fill-ins replaced in every title and description', !!brief && !!date && !!design && !!launch && brief.description === 'Who Aurora is for and what is new.', [...byTitle.keys()]);
    check('playbook: due dates count from the start date', brief?.due === '2026-12-03' && date?.due === '2026-12-02' && list?.due === '2026-12-03' && design?.due === '2026-12-08' && launch?.due === '2026-12-22',
      made.map((t) => [t.title, t.due]));
    check('playbook: subtasks sit under their parent, in its project', date?.parent_task_id === brief?.id && list?.parent_task_id === brief?.id && brief?.parent_task_id === null
      && made.every((t) => t.project_id === s.launches));
    check('playbook: priority and tags come along; everything starts To Do', brief?.priority === 'high' && launch?.priority === 'urgent' && JSON.stringify(brief?.tags) === '["launch"]'
      && made.every((t) => t.status === 'todo'));
    check('playbook: whoever used it is "runner"; a named person stays; nobody is nobody', JSON.stringify(brief?.assignees) === JSON.stringify([s.morgan])
      && JSON.stringify(date?.assignees) === JSON.stringify([s.morgan]) && launch?.assignees.length === 0 && made.every((t) => t.created_by === s.morgan), made.map((t) => [t.title, t.assignees]));
    check('playbook: someone who cannot open the project is left off, and a note says so', design?.assignees.length === 0
      && (used.body?.data?.notes ?? []).some((n: string) => n.startsWith('Sam cannot open Launches')), used.body?.data?.notes);
    check('task service: each task is logged as created, as any task is', await count("SELECT count(*)::int AS n FROM pm.activities WHERE type = 'task.created' AND entity_id = ANY($1::text[])", [made.map((t) => t.id)]) >= 3);

    // ── The run row and its webhook ────────────────────────────────────
    const run = (await s.q<Loose>('SELECT * FROM pm.task_template_runs WHERE template_id = $1', [launchId]))[0];
    check('run: recorded with its version, snapshot, values, who and how', !!run && run.template_version === 1 && run.run_by === s.morgan && run.via === 'app'
      && run.field_values.product === 'Aurora' && run.snapshot.name === 'Product launch' && run.snapshot.items.length === 3 && run.project_id === s.launches, run);
    check('run: lists every task it made, in order', JSON.stringify(run?.task_ids) === JSON.stringify(usedTasks.map((t) => t.id)), run?.task_ids);
    const runEvent = (await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'template.run' AND resource_id = $1", [run?.id]))[0];
    check('webhook: template.run carries the run and concerns who ran it', runEvent?.payload?.data?.run?.template_id === launchId
      && runEvent.payload.data.run.task_ids.length === 5 && runEvent.payload.data.member_ids.includes(s.morgan), runEvent?.payload);
    check('webhook: each task still sends its own task.created', await count("SELECT count(*)::int AS n FROM pm.webhook_events WHERE event_type = 'task.created' AND resource_id = ANY($1::uuid[])", [made.map((t) => t.id)]) === 5);
    const history = await session(runsRoute.GET, 'GET', `/api/workspace/task-templates/${launchId}/runs`, { id: launchId });
    check('run: the history names who used it and where', history.body?.data?.runs?.[0]?.run_by_name === 'Morgan' && history.body.data.runs[0].project_name === 'Launches'
      && history.body.data.runs[0].template_name === 'Product launch', history.body);
    const counted = await session(oneRoute.GET, 'GET', `/api/workspace/task-templates/${launchId}`, { id: launchId });
    check('library: counts uses and the last one', counted.body?.data?.run_count === 1 && !!counted.body.data.last_run_at, counted.body?.data);

    // ── Locked templates refuse another project ────────────────────────
    as(LOGINS.owner);
    const elsewhere = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${payrollId}/run`, { id: payrollId },
      { project_id: s.launches, values: { month: 'December' } });
    check('locked: another project is refused, nothing made', elsewhere.status === 422 && reason(elsewhere) === 'locked_to_project'
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE template_id = $1', [payrollId]) === 0, elsewhere.body);
    const lockedRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${payrollId}/run`, { id: payrollId }, { values: { month: 'December' }, start_date: '2026-12-01' });
    check('locked: it always creates in its own project, project_id left out', lockedRun.status === 201 && lockedRun.body.data.tasks[0].project_id === s.payroll
      && lockedRun.body.data.tasks[0].title === 'Upload the December payroll sheet' && lockedRun.body.data.tasks[0].due_date === '2026-12-04', lockedRun.body);

    // ── Using needs tasks.create ───────────────────────────────────────
    as(LOGINS.nina);
    const ninaRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.launches, values: { product: 'Nova' } });
    check('permissions: a member without tasks.create cannot use a template, nothing made', ninaRun.status === 403
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Nova%'") === 0, ninaRun.body);
    as(LOGINS.morgan);
    const outOfReach = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.payroll, values: { product: 'Nova' } });
    check('permissions: a project the member cannot open is refused', outOfReach.status === 403 && reason(outOfReach) === 'project_scope', outOfReach.body);
    const v1NoScope = await v1(v1Run.POST, 'POST', `/api/v1/task-templates/${launchId}/run`, { id: launchId }, s.keys.morganReadOnly, { project_id: s.launches, values: { product: 'Nova' } });
    check('permissions: a key without tasks.create is refused', v1NoScope.status === 403 && reason(v1NoScope) === 'missing_key_scope', v1NoScope.body);

    // ── The API and MCP ────────────────────────────────────────────────
    const v1Used = await v1(v1Run.POST, 'POST', `/api/v1/task-templates/${launchId}/run`, { id: launchId }, s.keys.morgan, { project_id: s.launches, values: { product: 'Vega' }, start_date: '2027-01-04' });
    check('v1: a key uses a template, the run says api', v1Used.status === 201 && v1Used.body.data.tasks.length === 5 && v1Used.body.data.run.via === 'api', v1Used.body);
    const v1Read = await v1(v1One.GET, 'GET', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.morgan);
    check('v1: one template with its tasks', v1Read.status === 200 && v1Read.body.data.items.length === 3 && v1Read.body.data.run_count === 2, v1Read.body);
    const v1History = await v1(v1Runs.GET, 'GET', `/api/v1/task-templates/${launchId}/runs`, { id: launchId }, s.keys.morgan);
    check('v1: runs, newest first', v1History.status === 200 && v1History.body.data[0].via === 'api' && v1History.body.meta.total === 2, v1History.body);
    const listed = await runTool(s.keys.owner, s.owner, 'list_task_templates', { project_id: s.payroll });
    check('mcp: list_task_templates', listed.ok === true && listed.data.length === 2, listed);
    const mcpRun = await runTool(s.keys.owner, s.owner, 'run_task_template', { template_id: payrollId, values: { month: 'January' } });
    check('mcp: run_task_template creates the tasks and says mcp', mcpRun.ok === true && mcpRun.data.tasks[0].title === 'Upload the January payroll sheet' && mcpRun.data.run.via === 'mcp', mcpRun);
    const mcpUpdate = await runTool(s.keys.owner, s.owner, 'update_task_template', { template_id: payrollId, name: 'Payroll upload' });
    check('mcp: update_task_template; a name change bumps the version', mcpUpdate.ok === true && mcpUpdate.data.name === 'Payroll upload' && mcpUpdate.data.version === 2, mcpUpdate);
    const patched = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${payrollId}`, { id: payrollId }, s.keys.owner, { items: [{ title: 'Upload the {quarter} sheet' }] });
    check('v1: items whose fill-ins the fields do not declare are refused', patched.status === 422 && reason(patched) === 'undeclared_field', patched.body);

    // ── Agents use templates under their rules ─────────────────────────
    const agentRun = (apiKey: string, product: string) => v1(v1Run.POST, 'POST', `/api/v1/task-templates/${launchId}/run`, { id: launchId }, apiKey,
      { project_id: s.launches, values: { product } });
    const madeFor = (product: string) => count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%' || $1 || '%'", [product]);
    const approval = await agentRun(s.agentKeys.careful, 'Quasar');
    check('agents: one whose new tasks need approval is refused (needs_approval), nothing made', approval.status === 403 && reason(approval) === 'needs_approval'
      && await madeFor('Quasar') === 0, approval.body);
    const paused = await agentRun(s.agentKeys.resting, 'Pulsar');
    check('agents: one paused on the project is refused (423), nothing made', paused.status === 423 && reason(paused) === 'project_paused'
      && await madeFor('Pulsar') === 0, paused.body);
    const switchedOff = await agentRun(s.agentKeys.helper, 'Nebula');
    check('agents: a personal assistant whose person turned off Create tasks is refused, nothing made', switchedOff.status === 403 && reason(switchedOff) === 'assistant_switch_off'
      && await madeFor('Nebula') === 0, switchedOff.body);

    // ── All or nothing ─────────────────────────────────────────────────
    as(LOGINS.morgan);
    const runsBefore = await count('SELECT count(*)::int AS n FROM pm.task_template_runs');
    const leftOver = async (product: string) => {
      const rows = await s.q<{ id: string; parent_task_id: string | null; deleted_at: string | null }>(
        "SELECT id, parent_task_id, deleted_at FROM pm.tasks WHERE title LIKE '%' || $1 || '%'", [product]);
      const tops = rows.filter((t) => !t.parent_task_id);
      const trashedTops = new Set(tops.filter((t) => t.deleted_at).map((t) => t.id));
      return { made: rows.length, top: tops.length, live: rows.filter((t) => !t.deleted_at && !(t.parent_task_id && trashedTops.has(t.parent_task_id))).length };
    };
    await s.q(`CREATE FUNCTION pm.test_fail_launch() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.title = 'Launch Boomer' THEN RAISE EXCEPTION 'The disk is full'; END IF; RETURN NEW; END $f$`);
    await s.q('CREATE TRIGGER test_fail_launch BEFORE INSERT ON pm.tasks FOR EACH ROW EXECUTE FUNCTION pm.test_fail_launch()');
    const midway = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.launches, values: { product: 'Boomer' } });
    await s.q('DROP TRIGGER test_fail_launch ON pm.tasks');
    const boomer = await leftOver('Boomer');
    check('all or nothing: a task failing part way sends the ones already made to Trash, and no run is recorded', midway.status === 500 && boomer.top >= 2 && boomer.live === 0
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs') === runsBefore, { status: midway.status, boomer });
    await s.q(`CREATE FUNCTION pm.test_fail_run() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.field_values ->> 'product' = 'Ghostrun' THEN RAISE EXCEPTION 'No room for the run'; END IF; RETURN NEW; END $f$`);
    await s.q('CREATE TRIGGER test_fail_run BEFORE INSERT ON pm.task_template_runs FOR EACH ROW EXECUTE FUNCTION pm.test_fail_run()');
    const noRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.launches, values: { product: 'Ghostrun' } });
    await s.q('DROP TRIGGER test_fail_run ON pm.task_template_runs');
    const ghost = await leftOver('Ghostrun');
    check('all or nothing: when the run cannot be recorded, every task it made goes to Trash (a retry never doubles it)', noRun.status >= 500 && ghost.made === 4 && ghost.live === 0
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs') === runsBefore, { status: noRun.status, ghost });

    // ── A full-size playbook finishes in good time ─────────────────────
    as(LOGINS.owner);
    const bigItems = Array.from({ length: 50 }, (_, i) => ({
      title: `Step ${i + 1} of the {client} onboarding`, assignee: i % 2 ? 'runner' : s.morgan, due_in_days: i,
      subtasks: [1, 2, 3].map((n) => ({ title: `Check ${n} for step ${i + 1}`, assignee: n === 2 ? s.morgan : null, due_in_days: i + n })),
    }));
    const big = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, { name: 'Client onboarding', fields: [{ key: 'client', label: 'Client' }], items: bigItems });
    const bigId = big.body?.data?.id as string;
    const startedBig = Date.now();
    const requestsBefore = requests;
    const bigRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${bigId}/run`, { id: bigId }, { project_id: s.launches, values: { client: 'Halcyon' } });
    bigRunMs = Date.now() - startedBig;
    bigRunRequests = requests - requestsBefore;
    const bigTasks = (bigRun.body?.data?.tasks ?? []) as Loose[];
    check('scale: a 200-task playbook (50 tasks, 150 subtasks) is made in one use', big.body?.data?.task_count === 200 && bigRun.status === 201 && bigTasks.length === 200
      && bigTasks.filter((t) => t.parent_task_id).length === 150 && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Halcyon%' AND deleted_at IS NULL") === 50, { status: bigRun.status, made: bigTasks.length });
    const bigSubtasks = bigTasks.filter((t) => t.parent_task_id === bigTasks[0]?.id).map((t) => t.sort_order);
    check('scale: subtasks keep their order under their parent, and named people stay', JSON.stringify(bigSubtasks) === '[0,1,2]'
      && bigTasks.filter((t) => (t.assignee_ids ?? []).includes(s.morgan)).length === 25 + 50, { bigSubtasks });
    check('scale: it finishes well inside the 60 second limit', bigRunMs < 30_000, bigRunMs);
    // One save per task and a handful of reads: about 220, plus background bookkeeping that varies
    // from run to run. The old per-task path made about 1,200, so 300 still catches a regression.
    check('scale: about one database call per task, not several', bigRunRequests <= 300, bigRunRequests);

    // ── Trash hides a template ─────────────────────────────────────────
    as(LOGINS.morgan);
    const morganTrash = await session(oneRoute.DELETE, 'DELETE', `/api/workspace/task-templates/${launchId}`, { id: launchId });
    check('permissions: a member cannot move a template to Trash', morganTrash.status === 403, morganTrash.body);
    as(LOGINS.admin);
    const trashed = await session(oneRoute.DELETE, 'DELETE', `/api/workspace/task-templates/${launchId}`, { id: launchId });
    check('trash: an Admin moves it to Trash', trashed.status === 200, trashed.body);
    const afterList = await session(listRoute.GET, 'GET', '/api/workspace/task-templates');
    const afterOne = await session(oneRoute.GET, 'GET', `/api/workspace/task-templates/${launchId}`, { id: launchId });
    const afterRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { project_id: s.launches, values: { product: 'Ghost' } });
    const afterV1 = await v1(v1List.GET, 'GET', '/api/v1/task-templates', {}, s.keys.owner);
    check('trash: hidden from the library, reads as missing, cannot be used', !afterList.body?.data?.templates?.some((t: Loose) => t.id === launchId)
      && afterOne.status === 404 && afterRun.status === 404 && !afterV1.body?.data?.some((t: Loose) => t.id === launchId), { list: afterList.body, one: afterOne.status, run: afterRun.status });
    check('trash: the row stays, marked; its tasks and runs stay', await count('SELECT count(*)::int AS n FROM pm.task_templates WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_by = $2', [launchId, s.admin]) === 1
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE template_id = $1', [launchId]) === 2
      && await count('SELECT count(*)::int AS n FROM pm.tasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [made.map((t) => t.id)]) === 5);

    // ── Settings > Trash: listed with the rest, restored the same way ──
    const asMember = async <T,>(login: { id: string } | null, work: () => Promise<T>): Promise<T> => {
      await actAs(db, login?.id ?? null);
      try { return await work(); } finally { await actAs(db, null); await db.exec('RESET ROLE'); }
    };
    const tryRestore = (templateId: string) => db.query<{ ok: boolean }>("SELECT pm.restore_record('task_templates', $1) AS ok", [templateId])
      .then((r) => r.rows[0]?.ok ?? null, (e: Error & { code?: string }) => e.code ?? e.message);
    const adminTrash = await asMember(LOGINS.admin, async () => (await db.query<Loose>(
      "SELECT record_type, id, label, context, deleted_by_name, blocker FROM pm.list_trash(ARRAY['task_templates'])")).rows);
    const listedInTrash = adminTrash.find((row) => row.id === launchId);
    check('trash: a template is listed in Settings > Trash with who moved it', listedInTrash?.record_type === 'task_templates' && listedInTrash.label === 'Product launch'
      && listedInTrash.deleted_by_name === 'Adam' && listedInTrash.blocker === null, adminTrash);
    const morganSees = await asMember(LOGINS.morgan, async () => (await db.query<Loose>("SELECT id FROM pm.list_trash(ARRAY['task_templates'])")).rows.length);
    const morganRestore = await asMember(LOGINS.morgan, () => tryRestore(launchId));
    check('trash: someone without templates.manage neither sees it in Trash nor restores it', morganSees === 0 && morganRestore === '42501', { morganSees, morganRestore });
    const restored = await asMember(LOGINS.admin, () => tryRestore(launchId));
    as(LOGINS.morgan);
    const backInLibrary = await session(listRoute.GET, 'GET', '/api/workspace/task-templates');
    check('trash: restoring brings it back to the library as it was', restored === true && backInLibrary.body?.data?.templates?.some((t: Loose) => t.id === launchId && t.run_count === 2)
      && await count('SELECT count(*)::int AS n FROM pm.task_templates WHERE id = $1 AND deleted_at IS NULL AND deleted_by IS NULL', [launchId]) === 1, { restored, list: backInLibrary.body });
    check('trash: the move and the restore ping live sync', await count("SELECT count(*)::int AS n FROM pm.trash_events WHERE table_name = 'task_templates' AND record_id = $1", [launchId]) === 2);
    // A template locked to a project in Trash comes back only after its project.
    as(LOGINS.owner);
    const lockedTrash = await v1(v1One.DELETE, 'DELETE', `/api/v1/task-templates/${payrollId}`, { id: payrollId }, s.keys.owner);
    await s.q('UPDATE pm.projects SET deleted_at = now() WHERE id = $1', [s.payroll]);
    const lockedBlocked = await asMember(LOGINS.owner, () => tryRestore(payrollId));
    await s.q('UPDATE pm.projects SET deleted_at = NULL WHERE id = $1', [s.payroll]);
    const lockedBack = await asMember(LOGINS.owner, () => tryRestore(payrollId));
    check('trash: a locked template waits for its project, then comes back', lockedTrash.status === 200 && lockedBlocked === '55000' && lockedBack === true, { lockedTrash: lockedTrash.body, lockedBlocked, lockedBack });
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`${passed} passed, ${failures.length} failed (a 200-task use took ${bigRunMs} ms, ${bigRunRequests} database calls)`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
