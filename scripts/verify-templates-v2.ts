/**
 * Templates v2 (20261126000200_templates_v2.sql), over the real routes and
 * services (session routes with a signed-in member, v1 routes with keys, MCP
 * tools through routeCaller, a fake PostgREST over PGlite with the full
 * schema):
 * - The migration, run twice on the schema before it, matches schema.sql; a
 *   run recorded the 2.0.45 way still records; the version follows key
 *   dates, roles and guidance; run task links are never deleted and are
 *   server only.
 * - Keys: every task and subtask gets a stable key; given ones stay; the
 *   same items get the same keys, so the same change twice keeps the version.
 * - A v1 writer replacing items (no keys, no v2 fields) keeps working.
 * - Anchors: due dates count from named key dates, negative offsets included.
 * - Validate returns every error with its precise JSON path (unknown anchor,
 *   duplicate key, dependency loop with its cycle, unknown dependency, a
 *   subtask dependency, offset out of range, undeclared fill-in, unknown
 *   property); create refuses with the same errors; nothing is written.
 * - Preview is exactly what the run makes, and writes nothing.
 * - A run makes real task dependencies and run task links with item_key
 *   and planned_due_date; with create_initiative true, an initiative (target
 *   = main key date, owner from a role) with its tasks inside it. By default
 *   (create_initiative left out) no initiative, as before.
 * - Roles: a run's map assigns; mapping someone else needs tasks.manage_all
 *   (403 cannot_assign_others); a template's default member stands; a
 *   required role without anyone (an explicit null included) is refused.
 * - Refusals keep the details 2.0.34 answered (keys, project_id,
 *   member_ids, too_many_fields) beside the errors list.
 * - A run failing at the last step (recording it) sends its tasks and its
 *   initiative to Trash, and records nothing.
 * - Who may write: a project manager writes the project's templates, a
 *   member cannot, company-wide needs templates.manage; Trash follows.
 * - template.run gains key_dates and initiative_id, every older key kept.
 * - The JSON Schema endpoint; Idempotency-Key on create and update; MCP.
 * - New code on a database without the migration says so (503).
 *
 *   npm run -s test:templates-v2
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  assignTemplateKeys, dueLabel, issuesFromZod, keyDateOrderWarnings, planRun, runDateWarnings, templateDocumentSchema, templateIssues, templateJsonSchemas, templateWarnings, type TemplateTask,
} from '../src/lib/task-templates';
import { PRODUCT_LAUNCH_EXAMPLE } from '../src/lib/task-template-schema';

const MIGRATION = '20261126000200_templates_v2.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- TEMPLATES V2 (20261126000200_templates_v2.sql)\n-- ============================================================\n';

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
  owner: { id: id(2101), email: 'olivia@studio.example' },
  admin: { id: id(2102), email: 'adam@studio.example' },
  morgan: { id: id(2103), email: 'morgan@studio.example' },
  nina: { id: id(2104), email: 'nina@studio.example' },
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
  const keyed = assignTemplateKeys([
    { title: 'A', subtasks: [{ title: 'A1' }, { key: 't1.2', title: 'A2' }] },
    { key: 't3', title: 'B' },
    { title: 'C' },
    { title: 'D' },
  ] as TemplateTask[]);
  check('keys: given keys stay; the rest come from their place, skipping any taken', JSON.stringify(keyed.map((t) => [t.key, (t.subtasks ?? []).map((s) => s.key)]))
    === JSON.stringify([['t1', ['t1.1', 't1.2']], ['t3', []], ['t3-2', []], ['t4', []]]), keyed.map((t) => t.key));
  check('keys: the same items always get the same keys', JSON.stringify(assignTemplateKeys(keyed)) === JSON.stringify(keyed));

  const plan = planRun(assignTemplateKeys([
    { title: 'Brief', anchor: 'kickoff', due_in_days: 2 },
    { title: 'Assets', role: 'designer', assignee: 'runner', anchor: 'launch', due_in_days: -14, depends_on: ['t1'], subtasks: [{ title: 'Cards', due_in_days: -1 }] },
    { title: 'Retro', due_in_days: 14 },
  ] as TemplateTask[]), { keyDates: { kickoff: '2026-12-30', launch: '2027-01-15' }, defaultAnchor: 'launch', values: {}, runnerId: id(1), roleMembers: { designer: id(2) } });
  check('anchors: due dates count from their own key date, negative offsets before it, across a year end', plan[0].due_date === '2027-01-01'
    && plan[1].due_date === '2027-01-01' && plan[1].subtasks[0].due_date === '2027-01-14' && plan[2].due_date === '2027-01-29', plan.map((t) => [t.title, t.due_date]));
  check('roles: a mapped role wins over the task\'s own assignee', plan[1].assignee_id === id(2) && JSON.stringify(plan[1].depends_on) === '["t1"]');
  check('words: a negative offset reads before its key date', dueLabel(-3, 'Launch date') === 'Due 3 days before Launch date' && dueLabel(2) === 'Due 2 days after start');

  const broken = {
    name: 'Broken',
    key_dates: [{ key: 'launch', label: 'Launch', main: true }, { key: 'kickoff', label: 'Kickoff', main: true }],
    roles: [{ key: 'designer', label: 'Designer' }],
    fields: [{ key: 'tier', label: 'Tier', type: 'choice' }],
    items: [
      { key: 'a', title: 'Brief for {product}', depends_on: ['c'] },
      { key: 'b', title: 'Assets', anchor: 'go_live', role: 'writer', depends_on: ['a'] },
      { key: 'c', title: 'Copy', depends_on: ['b', 'nope', 'a.sub'], subtasks: [{ key: 'a.sub', title: 'Sub' }] },
      { key: 'b', title: 'Again' },
    ],
  };
  const issues = templateIssues(broken);
  const at = (path: string, code: string) => issues.find((issue) => issue.path === path && issue.code === code);
  check('rules: an unknown anchor, at its path, with the key dates to use', !!at('items[1].anchor', 'unknown_anchor') && /launch, kickoff/.test(at('items[1].anchor', 'unknown_anchor')?.hint ?? ''), issues);
  check('rules: an unknown role, at its path', !!at('items[1].role', 'unknown_role'));
  check('rules: a duplicate task key, at the second one', !!at('items[3].key', 'duplicate_key'));
  check('rules: a dependency on a missing key, and on a subtask', !!at('items[2].depends_on[1]', 'unknown_dependency') && !!at('items[2].depends_on[2]', 'dependency_not_top_level'));
  const loop = issues.find((issue) => issue.code === 'dependency_cycle');
  check('rules: a dependency loop is refused, with its cycle and path', !!loop && loop.path === 'items[0].depends_on[0]' && JSON.stringify(loop.cycle) === '["a","c","b","a"]', loop);
  check('rules: a fill-in no field declares, at the title', !!at('items[0].title', 'undeclared_field'));
  check('rules: two main key dates, and a choice without options', !!at('key_dates[1].main', 'main_key_date') && !!at('fields[0].options', 'choice_needs_options'));
  check('rules: a self-dependency is a loop of one', templateIssues({ items: [{ key: 'x', title: 'X', depends_on: ['x'] }] }).some((issue) => issue.code === 'dependency_cycle' && issue.path === 'items[0].depends_on[0]'));
  const shape = templateDocumentSchema.safeParse({ name: 'X', items: [{ title: 'A' }, { title: 'B', due_in_days: -4000, colour: 'red' }] });
  const shapeIssues = shape.success ? [] : issuesFromZod(shape.error);
  check('shape: an offset out of range and an unknown property, each at its path', shapeIssues.some((i) => i.path === 'items[1].due_in_days' && i.code === 'offset_out_of_range')
    && shapeIssues.some((i) => i.path === 'items[1].colour' && i.code === 'unknown_property'), shapeIssues);
  check('rules: the worked example is clean', templateIssues(PRODUCT_LAUNCH_EXAMPLE).length === 0 && templateDocumentSchema.safeParse(PRODUCT_LAUNCH_EXAMPLE).success);

  // Dates that may not be meant: a task due before what it waits on warns at save and at run; it never refuses.
  const impossibleDoc = {
    key_dates: [{ key: 'kickoff', label: 'Kickoff' }, { key: 'golive', label: 'Go-live' }],
    items: [
      { key: 'moodboard', title: 'Moodboard', anchor: 'kickoff', due_in_days: 7 },
      { key: 'checklist', title: 'Go-live checklist', anchor: 'kickoff', due_in_days: 2, depends_on: ['moodboard'] },
      { key: 'sameday', title: 'Same day', anchor: 'kickoff', due_in_days: 7, depends_on: ['moodboard'] },
      { key: 'launch', title: 'Launch', anchor: 'golive', due_in_days: -10, depends_on: ['moodboard'] },
      { key: 'undated', title: 'Undated', depends_on: ['moodboard'] },
    ],
  };
  const impossible = templateIssues(impossibleDoc);
  check('rules: a task due before what it waits on is never an error (existing templates keep saving)', !impossible.some((issue) => issue.code === 'dependency_due_before'), impossible);
  const dueBefore = templateWarnings(impossibleDoc).filter((issue) => issue.code === 'dependency_due_before');
  check('warnings: a task due before what it waits on, from the same key date, is warned in true words with a fix', dueBefore.length === 1
    && dueBefore[0].path === 'items[1].depends_on[0]'
    && dueBefore[0].message === '"Go-live checklist" is due before a task it waits on: due 2 days after Kickoff, while "Moodboard" is due 7 days after Kickoff'
    && /5 days later/.test(dueBefore[0].hint), dueBefore);
  const ordered = keyDateOrderWarnings([{ key: 'kickoff', label: 'Kickoff' }, { key: 'golive', label: 'Go-live' }], { kickoff: '2026-11-30', golive: '2026-11-27' });
  check('run warnings: Go-live before Kickoff is said plainly', ordered.length === 1 && ordered[0].code === 'key_dates_out_of_order'
    && ordered[0].message === 'Go-live, Nov 27, 2026, is before Kickoff, Nov 30, 2026' && JSON.stringify(ordered[0].keys) === '["golive","kickoff"]', ordered);
  check('run warnings: key dates in order, or not set yet, warn nothing', keyDateOrderWarnings([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], { a: '2026-11-27', b: '2026-11-27' }).length === 0
    && keyDateOrderWarnings([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], { b: '2026-11-27' }).length === 0);
  const late = runDateWarnings([
    { key: 'moodboard', title: 'Moodboard', due_date: '2026-12-07' },
    { key: 'checklist', title: 'Go-live checklist', due_date: '2026-11-27', depends_on: ['moodboard'] },
    { key: 'after', title: 'After', due_date: '2026-12-07', depends_on: ['moodboard'] },
  ], [{ key: 'kickoff', label: 'Kickoff' }, { key: 'golive', label: 'Go-live' }], { kickoff: '2026-11-30', golive: '2026-11-27' });
  check('run warnings: key dates first, then each task due before what it waits on (same day is fine)', late.length === 2 && late[0].code === 'key_dates_out_of_order'
    && late[1].code === 'due_before_dependency' && late[1].message === 'Go-live checklist is due Nov 27, 2026 but waits on Moodboard, due Dec 7, 2026'
    && JSON.stringify(late[1].keys) === '["checklist","moodboard"]', late);
  const schemas = templateJsonSchemas() as Loose;
  const itemProps = schemas.template?.properties?.items?.items?.properties ?? {};
  check('schema: the JSON Schema has key dates, roles, guidance and each item\'s key, anchor, role and depends_on', ['key_dates', 'roles', 'guidance', 'fields', 'items'].every((k) => k in (schemas.template?.properties ?? {}))
    && ['key', 'anchor', 'role', 'depends_on', 'due_in_days', 'subtasks'].every((k) => k in itemProps) && schemas.template.additionalProperties === false
    && itemProps.due_in_days?.anyOf?.some((t: Loose) => t.minimum === -3650), Object.keys(itemProps));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  // Its section runs to the next migration's banner (a later release's section follows it), or to the end.
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(join(__dirname, '..', 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  // A template and a run as 2.0.45 writes them, before the update.
  const oldTpl = (await old.query<{ id: string }>(`INSERT INTO pm.task_templates (name, items) VALUES ('Old', '[{"title":"Upload","due_in_days":3}]') RETURNING id`)).rows[0].id;
  const oldProject = (await old.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id")).rows[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  const upgraded = (await old.query<Loose>('SELECT key_dates, roles, guidance, version FROM pm.task_templates WHERE id = $1', [oldTpl])).rows[0];
  check('upgrade: an existing template gets the start key date, no roles, no guidance, its version kept', JSON.stringify(upgraded.key_dates) === '[{"key":"start","label":"Start date"}]'
    && JSON.stringify(upgraded.roles) === '[]' && upgraded.guidance === '' && upgraded.version === 1, upgraded);
  // 2.0.45 inserts runs without the new columns.
  const legacyRun = await old.query<Loose>(`INSERT INTO pm.task_template_runs (template_id, template_version, snapshot, project_id, via, start_date, field_values, task_ids)
    VALUES ($1, 1, '{"name":"Old"}', $2, 'api', '2026-12-01', '{}', '{}') RETURNING key_dates, role_members, initiative_id`, [oldTpl, oldProject]).then((r) => r.rows[0], (e: Error) => e.message);
  check('compatibility: a run recorded the 2.0.45 way still records, the new columns empty', legacyRun?.initiative_id === null && JSON.stringify(legacyRun?.key_dates) === '{}', legacyRun);
  await old.close();

  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => fresh.query(sql, params).then(() => null, (e: Error) => e.message);
  const tpl = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, items) VALUES ('Launch', '[{"title":"Go"}]') RETURNING id`))[0].id;
  const version = async () => (await q<{ version: number }>('SELECT version FROM pm.task_templates WHERE id = $1', [tpl]))[0].version;
  await q(`UPDATE pm.task_templates SET key_dates = '[{"key":"launch","label":"Launch"}]' WHERE id = $1`, [tpl]);
  const afterDates = await version();
  await q(`UPDATE pm.task_templates SET roles = '[{"key":"designer","label":"Designer"}]', guidance = 'Read the plan' WHERE id = $1`, [tpl]);
  const afterRoles = await version();
  await q(`UPDATE pm.task_templates SET guidance = 'Read the plan' WHERE id = $1`, [tpl]);
  check('database: the version follows key dates, roles and guidance, and only real changes', afterDates === 2 && afterRoles === 3 && await version() === 3, { afterDates, afterRoles });
  check('database: a template needs at least one key date', /task_templates_key_dates_shape/.test(await fail(`UPDATE pm.task_templates SET key_dates = '[]' WHERE id = $1`, [tpl]) ?? ''));
  const grants = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'pm' AND table_name = 'task_template_run_tasks' AND grantee IN ('anon', 'authenticated')`))[0].n;
  const fnGrant = (await q<{ ok: boolean }>(`SELECT has_function_privilege('authenticated', 'pm.record_task_template_run(jsonb, jsonb)', 'EXECUTE') AS ok`))[0].ok;
  check('database: run task links and the run recorder are server only', grants === 0 && fnGrant === false, { grants, fnGrant });
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
  const permit = (memberId: string, key: string) => q(
    "INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'app', 'allow'), ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [memberId, key]);
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const admin = await member('Adam', 'admin', LOGINS.admin);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const nina = await member('Nina', 'member', LOGINS.nina);
  const sam = await member('Sam', 'member');
  const atlas = await member('Atlas', 'agent');
  const gone = await member('Gone', 'member');
  await q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [gone]);
  // Morgan manages projects; Nina is a plain member.
  await permit(morgan, 'projects.manage');
  for (const permission of ['tasks.create', 'tasks.read', 'projects.read']) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [atlas, permission]);
  }
  const project = async (name: string, members: string[]) => {
    const projectId = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [projectId, m]);
    return projectId;
  };
  const launches = await project('Launches', [morgan, nina, atlas]);
  const payroll = await project('Payroll', [sam]);
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Launch team', 'launch-team') RETURNING id"))[0].id;
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['templates.manage', 'tasks.create', 'tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']),
    morgan: await key(morgan, ['projects.manage', 'tasks.create', 'tasks.read', 'projects.read']),
  };
  await q("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Harness', 'https://hooks.example/pm', 'whsec_test', ARRAY['template.run'])");
  return { q, owner, admin, morgan, nina, sam, atlas, gone, launches, payroll, group, keys };
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
    const previewRoute = await import('../src/app/api/workspace/task-templates/[id]/preview/route');
    const validateRoute = await import('../src/app/api/workspace/task-templates/validate/route');
    const v1List = await import('../src/app/api/v1/task-templates/route');
    const v1One = await import('../src/app/api/v1/task-templates/[id]/route');
    const v1Run = await import('../src/app/api/v1/task-templates/[id]/run/route');
    const v1Runs = await import('../src/app/api/v1/task-templates/[id]/runs/route');
    const v1Schema = await import('../src/app/api/v1/task-templates/schema/route');
    const v1Validate = await import('../src/app/api/v1/task-templates/validate/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { toolDefinition } = await import('../src/lib/mcp/core');
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
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, extra: Record<string, string> = {}) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const templates = () => count('SELECT count(*)::int AS n FROM pm.task_templates');
    const tasks = () => count('SELECT count(*)::int AS n FROM pm.tasks');
    const initiatives = () => count('SELECT count(*)::int AS n FROM pm.initiatives');

    // ── Who may write ──────────────────────────────────────────────────
    const projectBody = {
      name: 'Launch checklist', project_id: s.launches, items: [{ title: 'Book the room', assignee: 'runner', due_in_days: -2 }],
    };
    as(LOGINS.nina);
    const ninaCreate = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, projectBody);
    check('permissions: a project member who does not manage it cannot create its templates', ninaCreate.status === 403 && reason(ninaCreate) === 'missing_permission', ninaCreate.body);
    as(LOGINS.morgan);
    const morganCreate = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, projectBody);
    const projectTplId = morganCreate.body?.data?.id as string;
    check('permissions: whoever manages the project creates its template (scope project, editable)', morganCreate.status === 201 && morganCreate.body.data.scope === 'project'
      && morganCreate.body.data.can_edit === true && morganCreate.body.data.items[0].due_in_days === -2, morganCreate.body);
    const morganCompany = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, { ...projectBody, project_id: null });
    check('permissions: a company-wide template needs templates.manage', morganCompany.status === 403 && reason(morganCompany) === 'missing_permission'
      && morganCompany.body.error.details.needs === 'templates.manage', morganCompany.body);
    const morganElsewhere = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, { ...projectBody, project_id: s.payroll });
    check('permissions: a project the manager cannot open reads as not found (422 project_not_found at project_id)', morganElsewhere.status === 422
      && reason(morganElsewhere) === 'project_not_found' && morganElsewhere.body.error.details.errors[0].path === 'project_id', morganElsewhere.body);
    const promote = await session(oneRoute.PATCH, 'PATCH', `/api/workspace/task-templates/${projectTplId}`, { id: projectTplId }, { project_id: null });
    check('permissions: making a project template company-wide needs templates.manage', promote.status === 403, promote.body);
    as(LOGINS.nina);
    const ninaEdit = await session(oneRoute.PATCH, 'PATCH', `/api/workspace/task-templates/${projectTplId}`, { id: projectTplId }, { name: 'Mine now' });
    const ninaList = await session(listRoute.GET, 'GET', `/api/workspace/task-templates?project_id=${s.launches}`);
    check('permissions: a member cannot change it, and reads can_edit false', ninaEdit.status === 403 && ninaList.body?.data?.templates?.[0]?.can_edit === false, { edit: ninaEdit.body, list: ninaList.body });
    const v1Morgan = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.morgan, { name: 'Over the API', project_id: s.launches, items: [{ title: 'One' }] });
    const v1MorganCompany = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.morgan, { name: 'Company', items: [{ title: 'One' }] });
    check('permissions: a key with projects.manage writes its project\'s templates, not company-wide ones', v1Morgan.status === 201 && v1MorganCompany.status === 403, { a: v1Morgan.body, b: v1MorganCompany.body });

    // Trash follows the same rule, in the database too.
    const asMember = async <T,>(login: { id: string } | null, work: () => Promise<T>): Promise<T> => {
      await actAs(db, login?.id ?? null);
      try { return await work(); } finally { await actAs(db, null); await db.exec('RESET ROLE'); }
    };
    const v1MorganId = v1Morgan.body?.data?.id as string;
    as(LOGINS.nina);
    const ninaTrash = await session(oneRoute.DELETE, 'DELETE', `/api/workspace/task-templates/${v1MorganId}`, { id: v1MorganId });
    as(LOGINS.morgan);
    const morganTrash = await session(oneRoute.DELETE, 'DELETE', `/api/workspace/task-templates/${v1MorganId}`, { id: v1MorganId });
    const ninaRestore = await asMember(LOGINS.nina, () => db.query("SELECT pm.restore_record('task_templates', $1) AS ok", [v1MorganId]).then(() => 'ok', (e: Error & { code?: string }) => e.code ?? e.message));
    const morganSees = await asMember(LOGINS.morgan, async () => (await db.query<Loose>("SELECT id FROM pm.list_trash(ARRAY['task_templates'])")).rows.map((r) => r.id));
    const morganRestore = await asMember(LOGINS.morgan, () => db.query<{ ok: boolean }>("SELECT pm.restore_record('task_templates', $1) AS ok", [v1MorganId]).then((r) => r.rows[0]?.ok, (e: Error & { code?: string }) => e.code ?? e.message));
    check('trash: the project manager moves the project\'s template to Trash and restores it; a member can neither', ninaTrash.status === 403 && morganTrash.status === 200
      && ninaRestore === '42501' && morganSees.includes(v1MorganId) && morganRestore === true, { ninaTrash: ninaTrash.status, morganTrash: morganTrash.status, ninaRestore, morganSees, morganRestore });

    // ── Keys, and a v1 writer replacing items ──────────────────────────
    as(LOGINS.admin);
    const launch = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, PRODUCT_LAUNCH_EXAMPLE);
    const launchId = launch.body?.data?.id as string;
    check('create: the worked example saves with its keys, key dates, roles and guidance (company-wide)', launch.status === 201 && launch.body.data.scope === 'workspace'
      && launch.body.data.items.map((t: Loose) => t.key).join() === 'brief,assets,copy,review,ship,retro' && launch.body.data.items[1].subtasks[0].key === 'assets.social'
      && launch.body.data.key_dates.length === 2 && launch.body.data.roles.length === 3 && /release plan/.test(launch.body.data.guidance), launch.body);
    const plain = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.owner, {
      name: 'Onboarding', fields: [{ key: 'client', label: 'Client' }],
      items: [{ title: 'Kickoff with {client}', assignee: 'runner', due_in_days: 0 }, { title: 'Send the welcome pack', due_in_days: 2, subtasks: [{ title: 'Print it', due_in_days: 1 }] }],
    }, { 'Idempotency-Key': 'onboarding-create-1' });
    const plainId = plain.body?.data?.id as string;
    check('keys: tasks without keys get t1, t2, t2.1', plain.status === 201 && plain.body.data.items.map((t: Loose) => t.key).join() === 't1,t2' && plain.body.data.items[1].subtasks[0].key === 't2.1'
      && JSON.stringify(plain.body.data.key_dates) === '[{"key":"start","label":"Start date"}]', plain.body);
    const plainAgain = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.owner, {
      name: 'Onboarding', fields: [{ key: 'client', label: 'Client' }],
      items: [{ title: 'Kickoff with {client}', assignee: 'runner', due_in_days: 0 }, { title: 'Send the welcome pack', due_in_days: 2, subtasks: [{ title: 'Print it', due_in_days: 1 }] }],
    }, { 'Idempotency-Key': 'onboarding-create-1' });
    check('idempotency: a create retried with the same Idempotency-Key answers the first one, one template', plainAgain.status === 201 && plainAgain.body.data.id === plainId
      && plainAgain.headers.get('idempotency-replayed') === 'true' && await count("SELECT count(*)::int AS n FROM pm.task_templates WHERE name = 'Onboarding'") === 1, plainAgain.body);
    // A 2.0.34 writer: items replaced whole, no keys, no v2 fields, on a template that has key dates and roles.
    const v1Writer = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.owner, {
      fields: [{ key: 'product', label: 'Product' }],
      items: [{ title: 'Write the {product} brief', assignee: 'runner', due_in_days: 1 }, { title: 'Launch {product}', due_in_days: 5 }],
    });
    check('v1 writer: replacing items without keys still works; they get keys; key dates and roles stay', v1Writer.status === 200 && v1Writer.body.data.version === 2
      && v1Writer.body.data.items.map((t: Loose) => t.key).join() === 't1,t2' && v1Writer.body.data.key_dates.length === 2 && v1Writer.body.data.roles.length === 3, v1Writer.body);
    const sameAgain = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.owner, {
      fields: [{ key: 'product', label: 'Product' }],
      items: [{ title: 'Write the {product} brief', assignee: 'runner', due_in_days: 1 }, { title: 'Launch {product}', due_in_days: 5 }],
    });
    check('idempotency: the same change twice leaves one version (the same keys)', sameAgain.status === 200 && sameAgain.body.data.version === 2, sameAgain.body?.data?.version);
    const keyed1 = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.owner, { name: 'Product launch v2' }, { 'Idempotency-Key': 'rename-1' });
    const keyed2 = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.owner, { name: 'Product launch v2' }, { 'Idempotency-Key': 'rename-1' });
    check('idempotency: a change takes Idempotency-Key, and a retry gets the first answer', keyed1.status === 200 && keyed2.headers.get('idempotency-replayed') === 'true'
      && keyed2.body.data.version === keyed1.body.data.version, { a: keyed1.body?.data?.version, b: keyed2.headers.get('idempotency-replayed') });
    // Back to the worked example for the runs below.
    const restored = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${launchId}`, { id: launchId }, s.keys.owner, {
      name: 'Product launch', fields: PRODUCT_LAUNCH_EXAMPLE.fields, items: PRODUCT_LAUNCH_EXAMPLE.items,
    });
    check('update: a v2 change brings keys, roles and dependencies back', restored.status === 200 && restored.body.data.items[4].depends_on[0] === 'review', restored.body);

    // ── Validate: every error, at its path ─────────────────────────────
    const broken = {
      name: 'Broken launch',
      key_dates: [{ key: 'launch', label: 'Launch date' }],
      roles: [{ key: 'designer', label: 'Designer' }],
      items: [
        { key: 'brief', title: 'Brief for {product}', depends_on: ['review'], colour: 'red' },
        { key: 'assets', title: 'Assets', anchor: 'go_live', due_in_days: -10, depends_on: ['brief'] },
        { key: 'review', title: 'Review', depends_on: ['assets', 'missing'] },
        { key: 'assets', title: 'Again', due_in_days: -4000 },
      ],
    };
    const templatesBefore = await templates();
    const validated = await v1(v1Validate.POST, 'POST', '/api/v1/task-templates/validate', {}, s.keys.owner, { template: broken });
    const errors = (validated.body?.data?.errors ?? []) as Loose[];
    const has = (path: string, code: string) => errors.some((e) => e.path === path && e.code === code && typeof e.hint === 'string' && e.hint.length > 0);
    check('validate: answers 200, not valid, without writing', validated.status === 200 && validated.body.data.valid === false && validated.body.data.template === null && await templates() === templatesBefore, validated.body);
    check('validate: an unknown property, at its path', has('items[0].colour', 'unknown_property'), errors);
    check('validate: an offset out of range, at its path', has('items[3].due_in_days', 'offset_out_of_range'), errors);
    check('validate: an unknown anchor, at its path', has('items[1].anchor', 'unknown_anchor'), errors);
    check('validate: a duplicate key, at the second task', has('items[3].key', 'duplicate_key'), errors);
    check('validate: a dependency on a missing task, at its path', has('items[2].depends_on[1]', 'unknown_dependency'), errors);
    check('validate: a fill-in no field declares, at the title', has('items[0].title', 'undeclared_field'), errors);
    const cycle = errors.find((e) => e.code === 'dependency_cycle');
    check('validate: a dependency loop, with its path and its cycle', cycle?.path === 'items[0].depends_on[0]' && JSON.stringify(cycle?.cycle) === '["brief","review","assets","brief"]', cycle);
    const refused = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.owner, broken);
    check('create: refuses with exactly the errors validate gave, nothing written', refused.status === 422 && reason(refused) === errors[0].code
      && JSON.stringify(refused.body.error.details.errors) === JSON.stringify(errors) && await templates() === templatesBefore, refused.body?.error);
    const okValidate = await v1(v1Validate.POST, 'POST', '/api/v1/task-templates/validate', {}, s.keys.owner, { template: { name: 'Fine', items: [{ title: 'A' }, { title: 'B', depends_on: ['t1'] }] } });
    check('validate: a clean template is valid, shown as it would be saved (keyed), and savable', okValidate.body?.data?.valid === true && okValidate.body.data.errors.length === 0
      && okValidate.body.data.template.items[1].key === 't2' && okValidate.body.data.can_save === true, okValidate.body);
    const changeCheck = await v1(v1Validate.POST, 'POST', '/api/v1/task-templates/validate', {}, s.keys.owner, { template: { key_dates: [{ key: 'kickoff', label: 'Kickoff' }] }, template_id: launchId });
    check('validate: a change is checked against the template it changes (dropping a key date its tasks use)', changeCheck.body?.data?.valid === false
      && changeCheck.body.data.errors.some((e: Loose) => e.code === 'unknown_anchor' && e.path === 'items[1].anchor'), changeCheck.body);
    as(LOGINS.morgan);
    const sessionValidate = await session(validateRoute.POST, 'POST', '/api/workspace/task-templates/validate', {}, { template: { ...projectBody, project_id: null } });
    check('validate: says when the caller could not save it (company-wide, no templates.manage)', sessionValidate.body?.data?.valid === true && sessionValidate.body.data.can_save === false, sessionValidate.body);
    const mcpValidate = await runTool(s.keys.owner, s.owner, 'validate_task_template', { template: broken });
    check('mcp: validate_task_template answers the same errors', mcpValidate.ok === true && JSON.stringify(mcpValidate.data.errors) === JSON.stringify(errors), mcpValidate);

    // ── Preview equals the run ─────────────────────────────────────────
    const runInput = {
      project_id: s.launches,
      key_dates: { kickoff: '2026-12-01', launch: '2027-01-15' },
      roles: { designer: s.atlas, copywriter: s.nina, reviewer: 'runner' },
      values: { product: 'Aurora', tier: 'Major' },
      create_initiative: true,
      initiative: { owner_role: 'designer' },
    };
    as(LOGINS.owner);
    const [tasksBefore, initiativesBefore] = [await tasks(), await initiatives()];
    const preview = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, runInput);
    const p = preview.body?.data;
    check('preview: writes nothing', preview.status === 200 && await tasks() === tasksBefore && await initiatives() === initiativesBefore
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs') === 0, preview.body);
    const due = Object.fromEntries((p?.tasks ?? []).map((t: Loose) => [t.key, t.due_date]));
    check('preview: due dates from their key dates, negative offsets before launch', p?.ok === true && due.brief === '2026-12-03' && due.assets === '2027-01-01'
      && due.copy === '2027-01-08' && due.review === '2027-01-12' && due.ship === '2027-01-15' && due.retro === '2027-01-29'
      && p.tasks[1].subtasks[0].due_date === '2027-01-03', { due, errors: p?.errors });
    const who = Object.fromEntries((p?.tasks ?? []).map((t: Loose) => [t.key, t.assignee_id]));
    check('preview: roles assign (an agent, a person, the runner); "runner" assignees are the runner', who.assets === s.atlas && who.copy === s.nina && who.review === s.owner
      && who.brief === s.owner && who.retro === null && p.tasks[1].subtasks[0].assignee_id === s.atlas, who);
    check('preview: dependencies by key, and the initiative (main key date, owner from a role)', p?.dependencies?.length === 6
      && p.dependencies.some((d: Loose) => d.task === 'review' && d.waits_on === 'assets') && p.initiative?.target_date === '2027-01-15' && p.initiative.start_date === '2026-12-01'
      && p.initiative.name === 'Product launch: Aurora, Major' && p.initiative.owner?.id === s.atlas && p.initiative.status === 'active', { deps: p?.dependencies, initiative: p?.initiative });
    check('preview: titles take the fill-ins; roles say where each member came from', p?.tasks?.[2]?.title === 'Write the Aurora announcement (Major launch)'
      && p.roles.find((r: Loose) => r.key === 'designer')?.source === 'run' && p.roles.find((r: Loose) => r.key === 'designer')?.member_name === 'Atlas', p?.roles);
    // A due date before today (the caller's time zone) is noted per task, subtasks too; a future plan notes none.
    const pastPreview = (await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, key_dates: { kickoff: '2020-01-06', launch: '2099-03-02' } })).body?.data;
    const futurePreview = (await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, key_dates: { kickoff: '2099-01-05', launch: '2099-03-02' } })).body?.data;
    const pastBrief = (pastPreview?.past_due ?? []).find((d: Loose) => d.key === 'brief');
    check('preview: past_due names each task due before today (key, title, date), and nothing for a future plan', pastPreview?.ok === true
      && pastBrief?.due_date === '2020-01-08' && pastBrief.title === pastPreview.tasks[0].title
      && (pastPreview.past_due as Loose[]).every((d) => d.due_date < '2026-01-01') && !(pastPreview.past_due as Loose[]).some((d) => d.key === 'ship')
      && Array.isArray(futurePreview?.past_due) && futurePreview.past_due.length === 0, { past: pastPreview?.past_due, future: futurePreview?.past_due });
    // Launch set before kickoff: the run still previews ok, and says so plainly, with every task now due before what it waits on.
    const backwards = (await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, key_dates: { kickoff: '2099-03-02', launch: '2099-01-05' } })).body?.data;
    const warned = (backwards?.date_warnings ?? []) as Loose[];
    check('preview: key dates out of order and tasks due before what they wait on are warned, the run still allowed', backwards?.ok === true
      && warned[0]?.code === 'key_dates_out_of_order' && warned[0].message === 'Launch date, Jan 5, 2099, is before Kickoff, Mar 2, 2099'
      && warned.some((w) => w.code === 'due_before_dependency' && JSON.stringify(w.keys) === '["assets","brief"]')
      && Array.isArray(futurePreview?.date_warnings) && futurePreview.date_warnings.length === 0, warned);

    const ran = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, runInput);
    const made = (ran.body?.data?.tasks ?? []) as Loose[];
    const rows = await s.q<Loose>(`SELECT t.id, t.title, left(t.due_date::text, 10) AS due, t.parent_task_id, t.initiative_id,
      coalesce((SELECT array_agg(a.member_id) FROM pm.task_assignees a WHERE a.task_id = t.id), '{}') AS assignees FROM pm.tasks t WHERE t.id = ANY($1::uuid[])`, [made.map((t) => t.id)]);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    const flat = (p?.tasks ?? []).flatMap((t: Loose) => [t, ...t.subtasks]);
    check('run: makes exactly what preview showed (titles, due dates, assignees, subtasks)', ran.status === 201 && rows.length === flat.length && flat.every((t: Loose) => {
      const row = byTitle.get(t.title);
      return !!row && row.due === t.due_date && JSON.stringify(row.assignees) === JSON.stringify(t.assignee_id ? [t.assignee_id] : []);
    }), { status: ran.status, flat: flat.map((t: Loose) => [t.title, t.due_date, t.assignee_id]), rows: rows.map((r) => [r.title, r.due, r.assignees]) });
    const initiative = ran.body?.data?.initiative;
    const initiativeRow = (await s.q<Loose>('SELECT name, status, owner_member_id, left(target_date::text, 10) AS target, left(start_date::text, 10) AS start, project_id FROM pm.initiatives WHERE id = $1', [initiative?.id]))[0];
    check('run: makes an active initiative targeting the main key date, owned by the designer, in the project', !!initiativeRow && initiativeRow.status === 'active'
      && initiativeRow.target === '2027-01-15' && initiativeRow.start === '2026-12-01' && initiativeRow.owner_member_id === s.atlas && initiativeRow.project_id === s.launches
      && initiativeRow.name === 'Product launch: Aurora, Major', initiativeRow);
    check('run: every task, subtasks too, is inside the initiative', rows.every((r) => r.initiative_id === initiative?.id), rows.map((r) => r.initiative_id));
    const run = (await s.q<Loose>('SELECT * FROM pm.task_template_runs WHERE template_id = $1', [launchId]))[0];
    check('run: recorded with its key dates, role map and initiative; start_date is the first key date', run?.initiative_id === initiative?.id
      && run.key_dates.launch === '2027-01-15' && run.role_members.designer === s.atlas && String(run.start_date instanceof Date ? run.start_date.toISOString() : run.start_date).slice(0, 10) === '2026-12-01'
      && run.snapshot.key_dates.length === 2 && run.snapshot.items[1].key === 'assets', run);
    const links = await s.q<Loose>('SELECT task_id, item_key, left(planned_due_date::text, 10) AS planned FROM pm.task_template_run_tasks WHERE run_id = $1', [run?.id]);
    const linkByKey = new Map(links.map((l) => [l.item_key, l]));
    check('run: one link per task with its item key and planned due date', links.length === 7 && linkByKey.get('assets')?.planned === '2027-01-01'
      && linkByKey.get('assets.social')?.planned === '2027-01-03' && linkByKey.get('ship')?.task_id === byTitle.get('Launch Aurora')?.id, links);
    const deps = await s.q<Loose>('SELECT task_id, blocked_by_task_id FROM pm.task_dependencies WHERE task_id = ANY($1::uuid[])', [made.map((t) => t.id)]);
    const idOf = (key: string) => linkByKey.get(key)?.task_id;
    check('run: dependencies become real task dependencies', deps.length === 6 && deps.some((d) => d.task_id === idOf('review') && d.blocked_by_task_id === idOf('assets'))
      && deps.some((d) => d.task_id === idOf('ship') && d.blocked_by_task_id === idOf('review')), deps.length);

    // ── The webhook gains fields, losing none ──────────────────────────
    const event = (await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'template.run' AND resource_id = $1", [run?.id]))[0];
    const mvpKeys = ['id', 'template_id', 'template_version', 'template_name', 'project_id', 'run_by', 'via', 'schedule_id', 'start_date', 'field_values', 'task_ids', 'created_at'];
    const runKeys = Object.keys(event?.payload?.data?.run ?? {});
    check('webhook: template.run keeps every 2.0.34 field and adds key_dates and initiative_id', mvpKeys.every((k) => runKeys.includes(k))
      && runKeys.length === mvpKeys.length + 2 && event.payload.data.run.initiative_id === initiative?.id && event.payload.data.run.key_dates.kickoff === '2026-12-01'
      && event.payload.data.project_id === s.launches, runKeys);

    // ── Refusals: key dates, roles, assign rights ──────────────────────
    const noLaunch = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, key_dates: { kickoff: '2026-12-01' } });
    check('preview: a missing key date is an error at its path', noLaunch.body?.data?.ok === false && noLaunch.body.data.errors.some((e: Loose) => e.path === 'key_dates.launch' && e.code === 'missing_key_date'), noLaunch.body);
    const beforeRefusals = await tasks();
    const noLaunchRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { ...runInput, key_dates: { kickoff: '2026-12-01' } });
    check('run: refuses a missing key date (422 missing_key_date), nothing made', noLaunchRun.status === 422 && reason(noLaunchRun) === 'missing_key_date' && await tasks() === beforeRefusals, noLaunchRun.body);
    const noDesigner = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, roles: { copywriter: s.nina }, initiative: undefined, create_initiative: undefined });
    check('preview: a required role with nobody is an error at its path', noDesigner.body?.data?.errors?.some((e: Loose) => e.path === 'roles.designer' && e.code === 'role_unmapped'), noDesigner.body);
    const noInitiative = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, create_initiative: undefined, initiative: undefined });
    check('initiative: off by default (create_initiative left out): the preview shows none and is otherwise clean', noInitiative.body?.data?.ok === true
      && noInitiative.body.data.initiative === null && noInitiative.body.data.tasks.length === 6, noInitiative.body?.data);
    const orphanOwner = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, { ...runInput, create_initiative: undefined });
    check('initiative: initiative sent without create_initiative true is an error at its path, not silently ignored', orphanOwner.body?.data?.ok === false
      && orphanOwner.body.data.errors.some((e: Loose) => e.path === 'initiative' && e.code === 'invalid_value'), orphanOwner.body?.data?.errors);
    as(LOGINS.morgan);
    const morganOthers = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, runInput);
    check('roles: mapping someone else without tasks.manage_all is an error per role (the runner is fine)', morganOthers.body?.data?.ok === false
      && morganOthers.body.data.errors.filter((e: Loose) => e.code === 'cannot_assign_others').map((e: Loose) => e.path).sort().join() === 'roles.copywriter,roles.designer', morganOthers.body?.data?.errors);
    const morganRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, runInput);
    check('roles: the run refuses it (403 cannot_assign_others), nothing made', morganRun.status === 403 && reason(morganRun) === 'cannot_assign_others' && await tasks() === beforeRefusals, morganRun.body);
    const morganSelf = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId },
      { ...runInput, values: { product: 'Nova', tier: 'Small' }, roles: { designer: 'runner', copywriter: s.morgan }, initiative: undefined, create_initiative: undefined });
    check('roles: mapping roles to yourself needs no extra right; by default (create_initiative left out) no initiative is made', morganSelf.status === 201 && morganSelf.body.data.initiative === null
      && morganSelf.body.data.run.initiative_id === null && morganSelf.body.data.tasks.find((t: Loose) => t.title === 'Design the Nova launch assets')?.assignee_ids?.[0] === s.morgan, morganSelf.body);
    // A default member written in the template stands, as the template's assignees do.
    as(LOGINS.admin);
    const withDefault = await session(listRoute.POST, 'POST', '/api/workspace/task-templates', {}, {
      name: 'Review cycle', roles: [{ key: 'reviewer', label: 'Reviewer', default_member_id: s.nina }], items: [{ title: 'Review it', role: 'reviewer' }],
    });
    as(LOGINS.morgan);
    const defaultRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${withDefault.body?.data?.id}/run`, { id: withDefault.body?.data?.id },
      { project_id: s.launches, create_initiative: true, initiative: { owner_group_id: s.group } });
    check('roles: a template\'s default member stands for a runner who may not assign others; a group may own the initiative', defaultRun.status === 201
      && defaultRun.body.data.tasks[0].assignee_ids?.[0] === s.nina && defaultRun.body.data.initiative?.owner_group_id === s.group, defaultRun.body);

    // ── A required role: an explicit null is still nobody ──────────────
    as(LOGINS.owner);
    const nullRole = { ...runInput, values: { product: 'Nullish', tier: 'Small' }, roles: { designer: null, copywriter: s.nina, reviewer: 'runner' }, create_initiative: undefined, initiative: undefined };
    const nullPreview = await session(previewRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/preview`, { id: launchId }, nullRole);
    check('roles: a required role mapped to null is an error in preview (role_unmapped at roles.designer)', nullPreview.body?.data?.ok === false
      && nullPreview.body.data.errors.some((e: Loose) => e.path === 'roles.designer' && e.code === 'role_unmapped'), nullPreview.body?.data?.errors);
    const nullRun = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, nullRole);
    check('roles: the run refuses a required role mapped to null (422 role_unmapped), nothing made', nullRun.status === 422 && reason(nullRun) === 'role_unmapped'
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title LIKE '%Nullish%'") === 0, nullRun.body);

    // ── Refusals keep the details 2.0.34 answered ─────────────────────
    const noValues = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { ...runInput, values: {}, create_initiative: undefined, initiative: undefined });
    check('legacy details: missing_values keeps details.keys', noValues.status === 422 && reason(noValues) === 'missing_values'
      && JSON.stringify(noValues.body.error.details.keys) === '["product","tier"]', noValues.body?.error?.details);
    const undeclaredCreate = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.owner, { name: 'Undeclared', items: [{ title: 'Call {client}' }, { title: 'Bill {client} for {month}' }] });
    check('legacy details: undeclared_field keeps details.keys', undeclaredCreate.status === 422 && reason(undeclaredCreate) === 'undeclared_field'
      && JSON.stringify(undeclaredCreate.body.error.details.keys) === '["client","month"]', undeclaredCreate.body?.error?.details);
    as(LOGINS.morgan);
    const lockedElsewhere = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${projectTplId}/run`, { id: projectTplId }, { project_id: s.payroll });
    check('legacy details: locked_to_project keeps details.project_id (the template\'s own project)', lockedElsewhere.status === 422 && reason(lockedElsewhere) === 'locked_to_project'
      && lockedElsewhere.body.error.details.project_id === s.launches, lockedElsewhere.body?.error?.details);
    as(LOGINS.owner);
    const goneAssignee = await v1(v1List.POST, 'POST', '/api/v1/task-templates', {}, s.keys.owner, { name: 'Gone', items: [{ title: 'One', assignee: s.gone }, { title: 'Two', subtasks: [{ title: 'Sub', assignee: s.gone }] }] });
    check('legacy details: assignee_not_active keeps details.member_ids', goneAssignee.status === 422 && reason(goneAssignee) === 'assignee_not_active'
      && JSON.stringify(goneAssignee.body.error.details.member_ids) === JSON.stringify([s.gone]) && goneAssignee.body.error.details.errors.length === 2, goneAssignee.body?.error?.details);
    const elevenFields = Array.from({ length: 11 }, (_, i) => ({ key: `field_${i}`, label: `Field ${i}` }));
    const tooMany = await v1(v1One.PATCH, 'PATCH', `/api/v1/task-templates/${plainId}`, { id: plainId }, s.keys.owner, { fields: elevenFields });
    check('legacy details: too many fill-in fields keeps the reason too_many_fields', tooMany.status === 422 && reason(tooMany) === 'too_many_fields'
      && tooMany.body.error.details.errors[0].code === 'out_of_range' && tooMany.body.error.details.errors[0].path === 'fields', tooMany.body?.error?.details);

    // ── A run that fails at the last step leaves nothing behind ────────
    await s.q(`CREATE FUNCTION pm.test_fail_v2_run() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.field_values ->> 'product' = 'Ghost' THEN RAISE EXCEPTION 'No room for the run'; END IF; RETURN NEW; END $f$`);
    await s.q('CREATE TRIGGER test_fail_v2_run BEFORE INSERT ON pm.task_template_runs FOR EACH ROW EXECUTE FUNCTION pm.test_fail_v2_run()');
    const runsBeforeGhost = await count('SELECT count(*)::int AS n FROM pm.task_template_runs');
    const ghost = await session(runRoute.POST, 'POST', `/api/workspace/task-templates/${launchId}/run`, { id: launchId }, { ...runInput, values: { product: 'Ghost', tier: 'Small' } });
    await s.q('DROP TRIGGER test_fail_v2_run ON pm.task_template_runs');
    const ghostInitiative = await s.q<Loose>("SELECT id, deleted_at FROM pm.initiatives WHERE name = 'Product launch: Ghost, Small'");
    const ghostTops = await s.q<Loose>("SELECT deleted_at FROM pm.tasks WHERE title LIKE '%Ghost%' AND parent_task_id IS NULL");
    check('rollback: a run with create_initiative true failing as it is recorded sends the initiative and every task to Trash, and records no run', ghost.status >= 500
      && ghostInitiative.length === 1 && !!ghostInitiative[0].deleted_at && ghostTops.length === 6 && ghostTops.every((t) => !!t.deleted_at)
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs') === runsBeforeGhost
      && await count('SELECT count(*)::int AS n FROM pm.task_template_run_tasks t JOIN pm.tasks x ON x.id = t.task_id WHERE x.title LIKE $1', ['%Ghost%']) === 0,
    { status: ghost.status, ghostInitiative, ghostTops: ghostTops.length });

    // ── 2.0.34 templates and runs unchanged ────────────────────────────
    as(LOGINS.owner);
    const mvpRun = await v1(v1Run.POST, 'POST', `/api/v1/task-templates/${plainId}/run`, { id: plainId }, s.keys.owner, { project_id: s.launches, start_date: '2026-12-30', values: { client: 'Acme' } });
    const mvpTasks = (mvpRun.body?.data?.tasks ?? []) as Loose[];
    check('compatibility: a 2.0.34 template runs as before (due dates start + N, runner assigned, no initiative)', mvpRun.status === 201
      && mvpRun.body.data.initiative === null && mvpRun.body.data.run.initiative_id === null
      && mvpTasks.every((t) => !t.initiative_id) && mvpTasks.map((t) => [t.title, t.due_date]).join('|')
      === 'Kickoff with Acme,2026-12-30|Send the welcome pack,2027-01-01|Print it,2026-12-31' && mvpTasks[0].assignee_ids?.[0] === s.owner
      && mvpRun.body.data.run.start_date === '2026-12-30' && mvpRun.body.data.run.key_dates.start === '2026-12-30', mvpRun.body);
    await s.q(`INSERT INTO pm.task_template_runs (template_id, template_version, snapshot, project_id, via, start_date, field_values, task_ids)
      VALUES ($1, 1, '{"name":"Onboarding"}', $2, 'api', '2026-10-01', '{}', '{}')`, [plainId, s.launches]);
    const history = await v1(v1Runs.GET, 'GET', `/api/v1/task-templates/${plainId}/runs`, { id: plainId }, s.keys.owner);
    const legacy = (history.body?.data ?? []).find((r: Loose) => r.start_date === '2026-10-01');
    check('compatibility: a run recorded the 2.0.45 way reads with its start date as its key date', legacy?.key_dates?.start === '2026-10-01' && legacy.initiative_id === null, legacy);

    // ── The JSON Schema endpoint and MCP ───────────────────────────────
    const schema = await v1(v1Schema.GET, 'GET', '/api/v1/task-templates/schema', {}, s.keys.morgan);
    check('schema: GET /api/v1/task-templates/schema publishes the JSON Schema, rules, error codes and the example', schema.status === 200
      && schema.body.data.schema_version === 2 && schema.body.data.template.properties.items.items.properties.depends_on && schema.body.data.run.properties.key_dates
      && schema.body.data.error_codes.dependency_cycle && schema.body.data.example.name === 'Product launch', Object.keys(schema.body?.data ?? {}));
    const createDefinition = toolDefinition(PM_TOOLS.find((t) => t.name === 'create_task_template')!) as Loose;
    check('mcp: create_task_template publishes the same schema in its input (key dates, roles, item keys and dependencies)', ['key_dates', 'roles', 'guidance'].every((k) => k in createDefinition.inputSchema.properties)
      && 'depends_on' in createDefinition.inputSchema.properties.items.items.properties);
    const mcpSchema = await runTool(s.keys.owner, s.owner, 'get_task_template_schema', {});
    const mcpList = await runTool(s.keys.owner, s.owner, 'list_task_templates', { scope: 'project' });
    const mcpGet = await runTool(s.keys.owner, s.owner, 'get_task_template', { template_id: launchId });
    const mcpCreated = await runTool(s.keys.morgan, s.morgan, 'create_task_template', { name: 'Sprint review', project_id: s.launches, items: [{ key: 'demo', title: 'Demo' }, { title: 'Notes', depends_on: ['demo'] }], idempotency_key: 'sprint-1' });
    const mcpUpdated = await runTool(s.keys.morgan, s.morgan, 'update_task_template', { template_id: mcpCreated.data?.id, guidance: 'Use the sprint board.' });
    const mcpPreview = await runTool(s.keys.morgan, s.morgan, 'preview_task_template_run', { template_id: mcpCreated.data?.id, start_date: '2026-12-07' });
    const mcpRun = await runTool(s.keys.morgan, s.morgan, 'run_task_template', { template_id: mcpCreated.data?.id, start_date: '2026-12-07', create_initiative: true, idempotency_key: 'sprint-run-1' });
    check('mcp: an agent reads the schema, lists by scope, reads one in full, creates, updates, previews and runs', mcpSchema.ok && mcpSchema.data.schema_version === 2
      && mcpList.ok && mcpList.data.every((t: Loose) => t.scope === 'project') && mcpGet.ok && mcpGet.data.items[0].key === 'brief'
      && mcpCreated.ok && mcpCreated.data.scope === 'project' && mcpUpdated.ok && mcpUpdated.data.guidance === 'Use the sprint board.'
      && mcpPreview.ok && mcpPreview.data.ok === true && mcpPreview.data.dependencies[0]?.waits_on === 'demo'
      && mcpRun.ok && mcpRun.data.run.via === 'mcp' && !!mcpRun.data.initiative?.id && mcpRun.data.tasks.length === 2,
    { mcpSchema: mcpSchema.ok, mcpList, mcpCreated, mcpUpdated: mcpUpdated.ok, mcpPreview: mcpPreview.data?.errors, mcpRun: mcpRun.error });
  } finally {
    await server.close();
    await db.close();
  }

  await oldDatabaseChecks();

  console.log(`templates v2: ${passed} passed, ${failures.length} failed`);
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
  const server = await startFakePostgrest(db, { strictColumns: true });
  try {
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { listTemplates } = await import('../src/lib/api/task-templates');
    const { API_ENDPOINT_PERMISSIONS } = await import('../src/lib/access-control');
    const client = createPmClient(server.url, 'fake-service-key', { auth: { persistSession: false, autoRefreshToken: false } });
    const access = (await resolveMemberAccess(client, owner))!;
    const caller = { memberId: owner, access, scopes: [...API_ENDPOINT_PERMISSIONS] as string[] };
    const pending = await listTemplates(client, caller, { offset: 0, limit: 10 }).then(() => null, (error: { statusCode?: number; details?: { reason?: string } }) => error);
    check('old database: listing templates says the update is pending (503)', pending?.statusCode === 503 && pending.details?.reason === 'migration_pending', pending);
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
