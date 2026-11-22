/**
 * Module guards: a switched-off module is out of reach on every path, not
 * only behind has_permission() in the app.
 *
 * - The real schema (schema.sql plus the module guards migration, twice):
 *   every table and every function a member can call is claimed in
 *   src/lib/modules/surfaces.ts; every policy on a module's tables and every
 *   module function asks for that module's permission or module_enabled();
 *   scheduled jobs and the webhook claim follow the switch; schema.sql holds
 *   exactly what the migration does.
 * - Real rows, owner and member, with a module off: nothing read, nothing
 *   written. Time approval needs no pay rate while Team pay is off, converts
 *   agent hours only while Client invoicing is on, and with both off finished
 *   time is approved as it is logged.
 * - Every route file under the module folders is claimed once.
 * - readEnabledModules on a stub client: missing table, other error, missing row.
 * - Real routes over fake-postgrest: withApi's MODULE_OFF answer, the agents
 *   check, the public portal and its sections, the live floor, the draft
 *   digest cron, the mail webhook storing with the Inbox off, key edits, MCP
 *   tool visibility and lead plan items.
 *
 * Nothing touches a live database.
 *
 *   npm run -s test:module-guards
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, createFullSchemaDatabase, schemaAt } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { FakeResend, FakeStorage, readEml, resendFixture } from './inbound-email-fixtures';
import { signSvix } from '../src/lib/communications/email/svix';
import type { AccessContext, PermissionKey } from '../src/lib/access-control';
import { MODULE_IDS, PERMISSION_MODULE, applyModuleChange, moduleOfPermission, type ModuleId } from '../src/lib/modules/registry';
import {
  CORE_RPCS,
  CORE_TABLES,
  LIVENESS_RPCS,
  MODULE_SURFACES,
  routeClaims,
  routeOwner,
} from '../src/lib/modules/surfaces';
import { ModuleReadError, enabledModuleSet, moduleEnabled, readEnabledModules } from '../src/lib/modules/server';

const APP = join(__dirname, '..');
const MIGRATION = '20261120201517_module_guards.sql';
const FOUNDATION = '20261120194316_workspace_modules.sql';
/** 2.0's move of the app into schema pm: from here on migrations target pm. */
const PM_MOVE = '20261123000000_move_to_pm.sql';
const MIGRATION_SQL = readFileSync(join(APP, 'supabase', 'migrations', MIGRATION), 'utf8');
const FOUNDATION_SQL = readFileSync(join(APP, 'supabase', 'migrations', FOUNDATION), 'utf8');
const SCHEMA_SQL = readFileSync(join(APP, 'supabase', 'schema.sql'), 'utf8');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// Route answers are read field by field; their shapes are what the checks assert.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

const OWNER_USER = '00000000-0000-0000-0000-00000000b001';
const MEMBER_USER = '00000000-0000-0000-0000-00000000b002';
const AGENT_MEMBER = '00000000-0000-0000-0000-00000000b0a1';

/** Setup writes run as the database owner, as a migration or the dashboard would. */
async function asDatabaseOwner(db: PGlite) {
  await actAs(db, null);
  await db.exec('RESET ROLE');
}

async function setModules(db: PGlite, enabled: readonly ModuleId[]) {
  await asDatabaseOwner(db);
  for (const id of MODULE_IDS) {
    await db.query('UPDATE pm.workspace_modules SET enabled = $2 WHERE module_id = $1', [id, enabled.includes(id)]);
  }
}
/** Everything on except `id` and what needs it, as the Settings switch leaves it. */
const allBut = (id: ModuleId) => applyModuleChange(MODULE_IDS, id, false);

const permissionsOf = (id: ModuleId) =>
  (Object.entries(PERMISSION_MODULE) as [PermissionKey, ModuleId | 'core'][]).filter(([, mod]) => mod === id).map(([key]) => key);

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

interface FunctionRow { nspname: string; proname: string; secdef: boolean; trigger: boolean; auth: boolean; anon: boolean; prosrc: string }
interface PolicyRow { schemaname: string; tablename: string; policyname: string; permissive: string; cmd: string; qual: string | null; with_check: string | null }

async function readFunctions(db: PGlite): Promise<FunctionRow[]> {
  return (await db.query<FunctionRow>(`
    SELECT n.nspname, p.proname, p.prosecdef AS secdef, p.prorettype = 'trigger'::regtype AS trigger,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pm' AND p.prokind = 'f'`)).rows;
}

const qualified = (schema: string, name: string) => (schema === 'pm' ? name : `${schema}.${name}`);

/** Whether SQL text asks for one of the module's permissions or module_enabled(), directly or through a helper it calls. */
function asksForModule(text: string, id: ModuleId, bodies: Map<string, string>, depth = 0): boolean {
  if (text.includes(`module_enabled('${id}'`)) return true;
  if (permissionsOf(id).some((key) => text.includes(`has_permission('${key}'`))) return true;
  if (depth >= 3) return false;
  for (const [, name] of text.matchAll(/([a-z_]+)\s*\(/g)) {
    const body = bodies.get(name);
    if (body && body !== text && asksForModule(body, id, bodies, depth + 1)) return true;
  }
  return false;
}

/** A body that refuses anything but the service role. */
const serviceOnly = (prosrc: string) => /auth\.role\(\)\s*<>\s*'service_role'/.test(prosrc);

async function staticChecks(db: PGlite) {
  const functions = await readFunctions(db);
  const bodies = new Map<string, string>();
  for (const fn of functions) bodies.set(fn.proname, `${bodies.get(fn.proname) ?? ''}\n${fn.prosrc}`);
  const policies = (await db.query<PolicyRow>(`SELECT schemaname, tablename, policyname, permissive, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'pm'`)).rows;
  const tables = (await db.query<{ name: string; rls: boolean }>(`
    SELECT CASE WHEN n.nspname = 'pm' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name, c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pm' AND c.relkind IN ('r', 'p')`)).rows;

  // Every table is claimed once.
  const claimed = new Map<string, string>();
  for (const id of MODULE_IDS) for (const table of MODULE_SURFACES[id].tables) {
    check(`surfaces: ${table} is claimed once`, !claimed.has(table), { first: claimed.get(table), second: id });
    claimed.set(table, id);
  }
  for (const table of CORE_TABLES) {
    check(`surfaces: core ${table} is not also a module's`, !claimed.has(table), claimed.get(table));
    claimed.set(table, 'core');
  }
  for (const { name } of tables) check(`surfaces: table ${name} is claimed by a module or core`, claimed.has(name));
  for (const name of claimed.keys()) check(`surfaces: claimed table ${name} exists`, tables.some((t) => t.name === name));

  // Every policy on a module's table asks for that module.
  for (const id of MODULE_IDS) for (const table of MODULE_SURFACES[id].tables) {
    const row = tables.find((t) => t.name === table);
    if (!row) continue;
    check(`rls: ${table} has row level security`, row.rls);
    const [schema, name] = table.includes('.') ? table.split('.') : ['pm', table];
    const own = policies.filter((p) => p.schemaname === schema && p.tablename === name);
    const gate = own.find((p) => p.permissive === 'RESTRICTIVE' && p.cmd === 'ALL' && (p.qual ?? '').includes(`module_enabled('${id}'`));
    if (gate) { passed++; continue; }
    for (const policy of own.filter((p) => p.permissive === 'PERMISSIVE')) {
      check(`rls: ${table}.${policy.policyname} asks for ${id}`, asksForModule(`${policy.qual ?? ''} ${policy.with_check ?? ''}`, id, bodies),
        { qual: policy.qual, with_check: policy.with_check });
    }
  }

  // Every function a member can call is claimed, and a module's asks for it.
  const moduleOfRpc = new Map<string, ModuleId>();
  for (const id of MODULE_IDS) for (const rpc of MODULE_SURFACES[id].rpcs) moduleOfRpc.set(rpc, id);
  for (const fn of functions.filter((f) => f.secdef && f.auth && !f.trigger)) {
    const name = qualified(fn.nspname, fn.proname);
    const known = moduleOfRpc.has(name) || CORE_RPCS.includes(name) || LIVENESS_RPCS.has(name) || serviceOnly(fn.prosrc);
    check(`surfaces: function ${name} (callable when signed in) is claimed`, known);
  }
  for (const [rpc, id] of moduleOfRpc) {
    const rows = functions.filter((f) => qualified(f.nspname, f.proname) === rpc);
    check(`rpc: ${rpc} exists`, rows.length > 0);
    for (const fn of rows) {
      if (!fn.secdef || !fn.auth || fn.trigger || LIVENESS_RPCS.has(rpc) || serviceOnly(fn.prosrc)) { passed++; continue; }
      check(`rpc: ${rpc} asks for ${id}`, asksForModule(fn.prosrc, id, bodies));
    }
  }
  for (const name of ['resolve_team_member_hourly_rate', 'validate_team_member_payout', 'apply_agent_billing_conversion']) {
    const fn = functions.find((f) => f.proname === name);
    check(`rpc: ${name} is internal (no signed-in or anonymous caller)`, !!fn && !fn.auth && !fn.anon, fn && { auth: fn.auth, anon: fn.anon });
  }
  const moduleFn = functions.find((f) => f.proname === 'module_enabled');
  check('rpc: module_enabled is for members, not visitors', !!moduleFn && moduleFn.auth && !moduleFn.anon);
}

/** Policies, function bodies and function privileges: what schema.sql and the migration must agree on. */
async function schemaLines(db: PGlite): Promise<string[]> {
  // Names print schema-qualified whatever path a session was left on (a migration may set one).
  const path = (await db.query<{ search_path: string }>('SHOW search_path')).rows[0].search_path;
  await db.exec('SET search_path TO pg_catalog');
  const rows = (await db.query<{ line: string }>(`
    SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' ' || permissive || ' ' || cmd
      || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') AS line
    FROM pg_policies WHERE schemaname = 'pm'
      AND policyname NOT IN ('project_goals_module_on', 'task_suggestions_module_on', 'agent_activities_module_on')
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure::text || ' ' || md5(replace(p.prosrc, chr(13), ''))
      || ' auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
      || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pm' AND p.prokind = 'f'`)).rows;
  await db.query('SELECT set_config($1, $2, false)', ['search_path', path]);
  return rows.map((r) => r.line).sort();
}

/** The core migrations after this one, oldest first. */
function laterMigrations(): Array<{ name: string; sql: string }> {
  const migrations = join(APP, 'supabase', 'migrations');
  return readdirSync(migrations).filter((name) => name.endsWith('.sql') && name > MIGRATION).sort()
    .map((name) => ({ name, sql: readFileSync(join(migrations, name), 'utf8') }));
}

/** schema.sql before this migration: its parent commit's copy once committed, HEAD's before. */
function schemaBefore(): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: APP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const added = git(['log', '--diff-filter=A', '--format=%H', '--', `supabase/migrations/${MIGRATION}`]).trim().split('\n').filter(Boolean).pop();
  return schemaAt(added ? `${added}^` : 'HEAD');
}

async function migrationChecks(applied: PGlite, fromSchema: PGlite) {
  const before = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  // The foundation lands in the same release; apply it if this copy predates it.
  await asDatabaseOwner(before);
  await before.exec(FOUNDATION_SQL);
  await before.exec(MIGRATION_SQL);
  await before.exec(MIGRATION_SQL);
  // Later migrations are in schema.sql too, so they are applied after this one
  // (2.0's move among them, which takes the app into pm).
  for (const later of laterMigrations()) await before.exec(later.sql);
  const [a, b] = [await schemaLines(fromSchema), await schemaLines(before)];
  const onlySchema = a.filter((line) => !b.includes(line));
  const onlyMigration = b.filter((line) => !a.includes(line));
  check('mirror: schema.sql holds exactly what the migration does', onlySchema.length === 0 && onlyMigration.length === 0,
    { onlySchema: onlySchema.slice(0, 6), onlyMigration: onlyMigration.slice(0, 6) });
  check('mirror: applying the 2.0 migrations on schema.sql changes nothing', JSON.stringify(await schemaLines(applied)) === JSON.stringify(a));
  await before.close();

  // The agent tables' gate lands where those tables exist (production applies migrations after both schema files).
  const gates = (await applied.query<{ tablename: string }>(`SELECT tablename FROM pg_policies
    WHERE policyname LIKE '%_module_on' AND permissive = 'RESTRICTIVE' AND qual LIKE '%module_enabled(''agents''%'`)).rows.map((r) => r.tablename);
  for (const table of ['project_goals', 'task_suggestions', 'agent_activities']) check(`rls: ${table} is gated on agents`, gates.includes(table));

  // Scheduled jobs: each command runs its function only while the module is on.
  const jobs = [...MIGRATION_SQL.matchAll(/cron\.schedule\('([a-z-]+)', '[^']+', \$job\$(.*?)\$job\$\)/g)].map((m) => ({ name: m[1], command: m[2] }));
  check('cron: the migration reschedules the three module jobs', JSON.stringify(jobs.map((j) => j.name).sort()) === JSON.stringify(['billing-drafts', 'retainer-drafts', 'webhook-retries']), jobs);
  // Since 2.0 the jobs are named pm-<name> and call pm functions: those are what a fresh install runs.
  const scheduled: Array<{ name: string; command: string }> = [];
  for (const name of ['retainer-drafts', 'billing-drafts', 'webhook-retries']) {
    const inSchema = [...SCHEMA_SQL.replace(/\r\n/g, '\n').matchAll(new RegExp(`cron\\.schedule\\(\\s*'pm-${name}',\\s*'[^']+',\\s*\\$job\\$(.*?)\\$job\\$`, 'g'))].map((m) => m[1]);
    check(`cron: schema.sql schedules pm-${name} only while its module is on`, inSchema.length === 1 && inSchema[0].includes('module_enabled('), inSchema);
    if (inSchema[0]) scheduled.push({ name, command: inSchema[0] });
  }
  for (const job of scheduled) {
    const mod: ModuleId = job.name === 'webhook-retries' ? 'webhooks' : 'billing';
    await setModules(applied, allBut(mod));
    const off = await applied.query(job.command.replace(/;$/, ''));
    await setModules(applied, MODULE_IDS);
    const on = await applied.query(job.command.replace(/;$/, ''));
    check(`cron: ${job.name} does nothing with ${mod} off`, off.rows.length === 0, off.rows);
    check(`cron: ${job.name} runs with ${mod} on`, on.rows.length === 1, on.rows);
  }
}

// ---------------------------------------------------------------------------
// Real rows
// ---------------------------------------------------------------------------

interface Seeded { owner: string; member: string; project: string; token: string; entry: string; invoice: string }

async function seed(db: PGlite): Promise<Seeded> {
  await asDatabaseOwner(db);
  const member = async (user: string, role: string, name: string) => {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, `${name}@example.com`]);
    const updated = await db.query(`UPDATE pm.team_members SET role = $2, status = 'active', name = $3 WHERE auth_user_id = $1`, [user, role, name]);
    if (!updated.affectedRows) {
      await db.query(`INSERT INTO pm.team_members (auth_user_id, name, email, role, status) VALUES ($1, $3, $4, $2, 'active')`, [user, role, name, `${name}@example.com`]);
    }
    return (await db.query<{ id: string }>('SELECT id FROM pm.team_members WHERE auth_user_id = $1', [user])).rows[0].id;
  };
  const owner = await member(OWNER_USER, 'owner', 'Owner');
  const memberId = await member(MEMBER_USER, 'member', 'Mia');
  await db.query(`INSERT INTO pm.team_members (id, name, email, role, status) VALUES ($1, 'Ashley', 'ashley@example.com', 'agent', 'active')`, [AGENT_MEMBER]);
  // The member holds every module permission used below, so only the switch can take it away.
  for (const key of ['time.manage_own', 'time.read_all', 'invoices.read', 'contacts.read_all', 'portal.read', 'credentials.manage', 'agents.manage', 'goals.read', 'suggestions.manage', 'projects.read_all', 'leads.read_all'])
    await db.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'app', 'allow') ON CONFLICT DO NOTHING`, [memberId, key]);
  await db.query('UPDATE pm.business_settings SET auto_approve_human_hours = false');

  const project = (await db.query<{ id: string }>("INSERT INTO pm.projects (name, client_time_billing) VALUES ('Acme Roofing', 'hourly') RETURNING id")).rows[0].id;
  await db.query('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, memberId]);
  await db.query(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Books', 'https://example.test/hook', 'whsec_x',
    ARRAY['invoice.paid', 'invoice.updated', 'invoice.deleted', 'invoice.payment_recorded', 'invoice.payment_removed'])`);
  await db.query(`INSERT INTO pm.project_invoices (project_id, invoice_number, amount, status, invoice_type, date, due_date)
    VALUES ($1, 'INV-001', 100, 'sent', 'fixed', '2026-11-01', '2999-01-01')`, [project]);
  const start = '2026-11-02T16:00:00.000Z';
  const end = '2026-11-02T18:00:00.000Z';
  const entry = (await db.query<{ id: string }>(`INSERT INTO pm.project_time_entries (project_id, member_id, start_time, end_time, segments, work_type)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'client') RETURNING id`, [project, memberId, start, end, JSON.stringify([{ start, end }])])).rows[0].id;
  const task = (await db.query<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Fix the gutter') RETURNING id", [project])).rows[0].id;
  await db.query('INSERT INTO pm.time_entry_tasks (time_entry_id, task_id) VALUES ($1, $2)', [entry, task]);
  const contact = (await db.query<{ id: string }>("INSERT INTO pm.contacts (name, email) VALUES ('Dana Wu', 'dana@acme.example') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO pm.project_contacts (project_id, contact_id, role, is_primary_client) VALUES ($1, $2, 'Client', true)", [project, contact]);
  const token = randomUUID().replace(/-/g, '');
  await db.query(`INSERT INTO pm.portal_settings (project_id, token, enabled, show_hours, show_invoices, show_credentials)
    VALUES ($1, $2, true, true, true, true)`, [project, token]);
  await db.query("INSERT INTO pm.agent_health (member_id, container) VALUES ($1, 'ashley')", [AGENT_MEMBER]);
  await db.query("INSERT INTO pm.project_credentials (project_id, label, encrypted_data, iv) VALUES ($1, 'Hosting', 'cipher', 'nonce')", [project]);
  const goal = (await db.query<{ id: string }>("INSERT INTO pm.project_goals (project_id, title) VALUES ($1, 'Launch') RETURNING id", [project])).rows[0].id;
  await db.query("INSERT INTO pm.task_suggestions (project_id, goal_id, proposed_by, title, description, reasoning) VALUES ($1, $2, $3, 'Add a sitemap', 'For search', 'Missing')", [project, goal, AGENT_MEMBER]);
  await db.query("INSERT INTO pm.leads (name) VALUES ('Birch Partners')");
  // Paid in full: the invoice.paid event queues a webhook delivery.
  const invoice = (await db.query<{ id: string }>('SELECT id FROM pm.project_invoices WHERE project_id = $1', [project])).rows[0].id;
  await actAs(db, OWNER_USER);
  await db.query(`SELECT pm.record_invoice_payment($1, '{"amount": 100, "paid_date": "2026-11-03"}'::jsonb)`, [invoice]);
  await asDatabaseOwner(db);
  return { owner, member: memberId, project, token, entry, invoice };
}

async function attempt(db: PGlite, sql: string, params: unknown[] = []): Promise<{ ok: boolean; rows: number; error?: string }> {
  try {
    const result = await db.query(sql, params);
    return { ok: true, rows: result.affectedRows ?? result.rows.length };
  } catch (error) {
    return { ok: false, rows: 0, error: (error as Error).message };
  }
}

async function rowChecks(db: PGlite, s: Seeded) {
  const cases: Array<{ mod: ModuleId; table: string; write?: [string, unknown[]] }> = [
    { mod: 'billing', table: 'project_invoices', write: [`INSERT INTO pm.project_invoices (project_id, invoice_number, amount, status, invoice_type, date, due_date) VALUES ($1, 'INV-900', 5, 'draft', 'fixed', '2026-11-03', '2026-12-03')`, [s.project]] },
    { mod: 'time', table: 'project_time_entries', write: [`INSERT INTO pm.project_time_entries (project_id, member_id, start_time, segments) SELECT $1, id, now(), '[]'::jsonb FROM pm.team_members WHERE auth_user_id = auth.uid()`, [s.project]] },
    { mod: 'time', table: 'time_entry_tasks', write: ['DELETE FROM pm.time_entry_tasks', []] },
    { mod: 'contacts', table: 'contacts', write: ["INSERT INTO pm.contacts (name, email) VALUES ('New', 'new@client.example')", []] },
    { mod: 'contacts', table: 'project_contacts' },
    { mod: 'portal', table: 'portal_settings', write: ["UPDATE pm.portal_settings SET welcome_message = 'Hi'", []] },
    { mod: 'agents', table: 'agent_health' },
    { mod: 'agents', table: 'project_goals', write: ["INSERT INTO pm.project_goals (project_id, title) VALUES ($1, 'More')", [s.project]] },
    { mod: 'agents', table: 'task_suggestions', write: ["UPDATE pm.task_suggestions SET title = 'Changed'", []] },
    { mod: 'credentials', table: 'project_credentials', write: ["INSERT INTO pm.project_credentials (project_id, label, encrypted_data, iv) VALUES ($1, 'More', 'c', 'n')", [s.project]] },
    { mod: 'sales', table: 'leads', write: ["INSERT INTO pm.leads (name) VALUES ('Another')", []] },
  ];
  for (const c of cases) {
    await setModules(db, MODULE_IDS);
    await actAs(db, OWNER_USER);
    const seen = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm.${c.table}`)).rows[0].n;
    check(`rows: owner reads ${c.table} with ${c.mod} on`, seen > 0, seen);
    await setModules(db, allBut(c.mod));
    for (const [who, user] of [['owner', OWNER_USER], ['member', MEMBER_USER]] as const) {
      await actAs(db, user);
      const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm.${c.table}`)).rows[0].n;
      check(`rows: ${who} reads no ${c.table} with ${c.mod} off`, n === 0, n);
      if (c.write) {
        await db.exec('BEGIN');
        const result = await attempt(db, c.write[0], c.write[1]);
        await db.exec('ROLLBACK');
        check(`rows: ${who} cannot write ${c.table} with ${c.mod} off`, !result.ok || result.rows === 0, result);
      }
    }
  }
  await setModules(db, MODULE_IDS);

  // Approving time. Pay is Team pay's: with it off no pay rate is needed or
  // set; with it on, still required. Agent billed-time conversion is Client
  // invoicing's. With both off there is nothing to review: finished time is
  // approved as it is logged, for every role.
  let minute = 0;
  const logged = async (memberId: string, finished = true) => {
    await asDatabaseOwner(db);
    // Distinct start times, so no two entries of one member overlap.
    const start = new Date(Date.UTC(2026, 10, 4, 6, 0) + (minute++) * 7_200_000).toISOString();
    const end = new Date(Date.parse(start) + 3600_000).toISOString();
    return (await db.query<{ id: string; approval_status: string; approved_by: string | null }>(`INSERT INTO pm.project_time_entries (project_id, member_id, start_time, end_time, segments, work_type)
      VALUES ($1, $2, $3, $4, $5::jsonb, 'client') RETURNING id, approval_status, approved_by`,
    [s.project, memberId, start, finished ? end : null, JSON.stringify(finished ? [{ start, end }] : [{ start }])])).rows[0];
  };
  const pending = () => logged(s.member);
  const entryRow = async (id: string) => {
    await asDatabaseOwner(db);
    return (await db.query<{ approval_status: string; approved_by: string | null; compensation_rate: string; billing_converted_at: string | null }>(
      'SELECT approval_status, approved_by, compensation_rate, billing_converted_at FROM pm.project_time_entries WHERE id = $1', [id])).rows[0];
  };
  const review = async (ids: string[]) => {
    await actAs(db, OWNER_USER);
    const result = await attempt(db, "SELECT id FROM pm.review_time_entries($1::uuid[], 'approved')", [ids]);
    await asDatabaseOwner(db);
    return result;
  };
  const NO_MONEY: ModuleId[] = ['time', 'contacts', 'inbox', 'agents', 'credentials'];

  const first = await pending();
  check('approval: a member entry waits for review', first.approval_status === 'pending', first);
  await setModules(db, NO_MONEY);
  const timeOnly = await review([first.id]);
  const firstAfter = await entryRow(first.id);
  check('approval: a time-only workspace approves a human entry with no rate', timeOnly.ok && firstAfter.approval_status === 'approved', { timeOnly, firstAfter });
  check('approval: and sets no pay', Number(firstAfter.compensation_rate) === 0, firstAfter);

  // Both money modules off: submitted time is approved as it is logged.
  const memberLogged = await logged(s.member);
  check('approval: with no money modules a member\'s finished entry is approved on submit',
    memberLogged.approval_status === 'approved' && memberLogged.approved_by === null, memberLogged);
  const agentLogged = await logged(AGENT_MEMBER);
  check('approval: with no money modules an agent\'s entry is approved on submit',
    agentLogged.approval_status === 'approved' && agentLogged.approved_by === null, agentLogged);
  const timer = await logged(AGENT_MEMBER, false);
  check('approval: a running timer stays a draft', timer.approval_status === 'draft', timer);
  await db.query(`UPDATE pm.project_time_entries SET end_time = start_time + interval '30 minutes',
    segments = jsonb_build_array(jsonb_build_object('start', start_time, 'end', start_time + interval '30 minutes')) WHERE id = $1`, [timer.id]);
  const stopped = await entryRow(timer.id);
  check('approval: stopping an agent timer with no money modules approves it', stopped.approval_status === 'approved' && stopped.approved_by === null, stopped);
  check('approval: and converts nothing', stopped.billing_converted_at === null, stopped);
  // With no pay attached, an approved entry can still be corrected by its member.
  await asDatabaseOwner(db);
  const correct = await attempt(db, "UPDATE pm.project_time_entries SET start_time = start_time - interval '15 minutes' WHERE id = $1", [memberLogged.id]);
  check('lock: with Team pay off the time of an approved entry can be corrected', correct.ok, correct);

  // Either money module on: today's review rules.
  await setModules(db, allBut('team_pay'));
  await asDatabaseOwner(db);
  const billedLock = await attempt(db, "UPDATE pm.project_time_entries SET start_time = start_time - interval '15 minutes' WHERE id = $1", [memberLogged.id]);
  check('lock: with Client invoicing on (Team pay off) the time of an approved entry is locked', !billedLock.ok && /compensation is locked/.test(billedLock.error ?? ''), billedLock);
  const agentWaits = await logged(AGENT_MEMBER);
  check('approval: with Client invoicing on an agent entry waits for review', agentWaits.approval_status === 'pending', agentWaits);
  const memberWaits = await pending();
  check('approval: with Client invoicing on a member entry waits (auto-approve off)', memberWaits.approval_status === 'pending', memberWaits);
  const invoicingOnly = await review([memberWaits.id, agentWaits.id]);
  const memberApproved = await entryRow(memberWaits.id);
  const agentApproved = await entryRow(agentWaits.id);
  check('approval: Client invoicing without Team pay approves a member with no pay rate',
    invoicingOnly.ok && memberApproved.approval_status === 'approved' && Number(memberApproved.compensation_rate) === 0, { invoicingOnly, memberApproved });
  check('approval: and still converts agent hours', agentApproved.approval_status === 'approved' && agentApproved.billing_converted_at !== null, agentApproved);

  await setModules(db, allBut('billing'));
  await asDatabaseOwner(db);
  const lockedNow = await attempt(db, "UPDATE pm.project_time_entries SET start_time = start_time - interval '15 minutes' WHERE id = $1", [memberLogged.id]);
  check('lock: with Team pay on the time of an approved entry is locked', !lockedNow.ok && /compensation is locked/.test(lockedNow.error ?? ''), lockedNow);
  const payOnlyAgent = await logged(AGENT_MEMBER);
  check('approval: with Team pay on an agent entry waits for review', payOnlyAgent.approval_status === 'pending', payOnlyAgent);
  const payOnlyMember = await pending();
  const payOnly = await review([payOnlyMember.id]);
  check('approval: with Team pay on (Client invoicing off) a missing rate blocks approval',
    !payOnly.ok && /Compensation rate missing/.test(payOnly.error ?? ''), payOnly);
  const payOnlyAgentReview = await review([payOnlyAgent.id]);
  const payOnlyAgentAfter = await entryRow(payOnlyAgent.id);
  check('approval: Team pay alone approves an agent with no conversion',
    payOnlyAgentReview.ok && payOnlyAgentAfter.approval_status === 'approved' && payOnlyAgentAfter.billing_converted_at === null, { payOnlyAgentReview, payOnlyAgentAfter });
  await actAs(db, null);
  const apiPayOnly = await attempt(db, "SELECT id FROM pm.review_time_entries_api($1, ARRAY[$2]::uuid[], 'approved', NULL, $3)", [s.project, payOnlyMember.id, s.owner]);
  check('approval: the API review asks for a rate with Team pay on', !apiPayOnly.ok && /Compensation rate missing/.test(apiPayOnly.error ?? ''), apiPayOnly);

  await setModules(db, MODULE_IDS);
  const second = await pending();
  check('approval: with everything on a member entry waits for review', second.approval_status === 'pending', second);
  const withBilling = await review([second.id]);
  check('approval: with Billing on a missing rate still blocks approval', !withBilling.ok && /Compensation rate missing/.test(withBilling.error ?? ''), withBilling);
  await setModules(db, allBut('team_pay'));
  await actAs(db, null);
  const apiReview = await attempt(db, "SELECT id FROM pm.review_time_entries_api($1, ARRAY[$2]::uuid[], 'approved', NULL, $3)", [s.project, second.id, s.owner]);
  check('approval: the API review needs no rate with Team pay off', apiReview.ok, apiReview);
  await setModules(db, MODULE_IDS);

  // The webhook claim hands out nothing while Webhooks is off; the delivery waits untouched.
  await asDatabaseOwner(db);
  const due = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.webhook_deliveries WHERE status = 'pending'")).rows[0].n;
  check('webhooks: an invoice change queued a delivery', due > 0, due);
  await setModules(db, allBut('webhooks'));
  await actAs(db, null);
  const offClaim = (await db.query('SELECT * FROM pm.claim_webhook_deliveries(20)')).rows.length;
  await setModules(db, allBut('billing'));
  await actAs(db, null);
  const noBillingClaim = (await db.query('SELECT * FROM pm.claim_webhook_deliveries(20)')).rows.length;
  await asDatabaseOwner(db);
  const untouched = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.webhook_deliveries WHERE status = 'pending' AND attempts = 0")).rows[0].n;
  check('webhooks: nothing is claimed with Webhooks off', offClaim === 0, offClaim);
  check('webhooks: nothing is claimed with Billing off', noBillingClaim === 0, noBillingClaim);
  check('webhooks: the waiting delivery keeps its attempts', untouched === due, { untouched, due });
  await setModules(db, MODULE_IDS);
  await actAs(db, null);
  await db.exec('BEGIN');
  const onClaim = (await db.query('SELECT * FROM pm.claim_webhook_deliveries(20)')).rows.length;
  await db.exec('ROLLBACK');
  check('webhooks: with both on it is claimed', onClaim > 0, onClaim);
}

// ---------------------------------------------------------------------------
// Routes on disk
// ---------------------------------------------------------------------------

function routeFiles(): string[] {
  const root = join(APP, 'src', 'app');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'route.ts' || name === 'route.tsx' || name === 'page.tsx') out.push(relative(root, full).split('\\').join('/'));
    }
  };
  for (const folder of ['api', '(protected)', 'portal', 'live', 'webhooks', 'smtp', 'dev', '(dashboard)']) {
    try { walk(join(root, folder)); } catch { /* a folder this checkout does not have */ }
  }
  return out;
}

function surfaceWalk() {
  const files = routeFiles();
  check('walk: route files found', files.length > 150, files.length);
  for (const file of files) {
    const dir = file.split('/').slice(0, -1).join('/');
    check(`walk: ${file} is claimed`, routeOwner(dir) !== null);
  }
  const claims = routeClaims();
  const seen = new Map<string, string>();
  for (const { prefix, owner } of claims) {
    check(`walk: ${prefix} is claimed once`, !seen.has(prefix), { first: seen.get(prefix), second: owner });
    seen.set(prefix, owner);
    check(`walk: claimed folder ${prefix} has routes`, files.some((file) => file.startsWith(`${prefix}/`)), prefix);
  }
  check('walk: time entries under a core project folder are Time tracking\'s',
    routeOwner('api/v1/projects/[id]/time-entries/[entryId]/stop')?.kind === 'module');
  check('walk: project context is core', routeOwner('api/v1/projects/[id]/context')?.kind === 'core');
  check('walk: the MCP route is core', routeOwner('api/mcp')?.kind === 'core');
}

// ---------------------------------------------------------------------------
// readEnabledModules on a stub client
// ---------------------------------------------------------------------------

function stub(result: { data: unknown; error: unknown }): SupabaseClient {
  return { from: () => ({ select: () => Promise.resolve(result) }) } as unknown as SupabaseClient;
}

async function readerChecks() {
  {
    let calls = 0;
    const flaky = { from: () => ({ select: () => Promise.resolve(++calls === 1
      ? { data: null, error: { code: '08006', message: 'connection failure' } }
      : { data: [{ module_id: 'portal', enabled: false }], error: null }) }) } as unknown as SupabaseClient;
    const read = await readEnabledModules(flaky);
    check('reader: a failed read is tried once more', calls === 2 && !!read && !read.includes('portal') && read.includes('billing'), { calls, read });
  }
  const missing = await readEnabledModules(stub({ data: null, error: { code: '42P01', message: 'relation "workspace_modules" does not exist' } }));
  check('reader: before the migration every module is on', JSON.stringify(missing) === JSON.stringify(MODULE_IDS), missing);
  const cache = await readEnabledModules(stub({ data: null, error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' } }));
  check('reader: a schema cache miss counts as before the migration', JSON.stringify(cache) === JSON.stringify(MODULE_IDS), cache);
  const broken = await readEnabledModules(stub({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }));
  check('reader: another error is null (fail closed)', broken === null, broken);
  check('reader: moduleEnabled throws on a failed read', await moduleEnabled(stub({ data: null, error: { code: '08006', message: 'connection failure' } }), 'portal').then(() => false, (e) => e instanceof ModuleReadError));
  check('reader: enabledModuleSet throws on a failed read', await enabledModuleSet(stub({ data: null, error: { code: '08006', message: 'x' } })).then(() => false, (e) => e instanceof ModuleReadError));
  const partial = await readEnabledModules(stub({ data: [{ module_id: 'billing', enabled: false }, { module_id: 'time', enabled: true }], error: null }));
  check('reader: a module with no row is on', !!partial && partial.includes('agents') && partial.includes('time'), partial);
  check('reader: a row switched off is off', !!partial && !partial.includes('billing'), partial);
}

// ---------------------------------------------------------------------------
// Routes, over fake-postgrest
// ---------------------------------------------------------------------------

const RELAY = 'relay.example.test';
const SVIX_SECRET = `whsec_${Buffer.from('module-guards-test-signing-secret!').toString('base64')}`;
const CRON_SECRET = 'module-guards-cron-secret-0123456789';
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function routeChecks(db: PGlite, s: Seeded) {
  await asDatabaseOwner(db);
  const keys = { owner: `pk_live_${randomUUID()}`, ownerNarrow: `pk_live_${randomUUID()}` };
  const ownerKey = (await db.query<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes)
    VALUES ('Owner', 'pk_live_owner', $1, $2, $2, $3) RETURNING id`,
  [hash(keys.owner), s.owner, ['invoices.read', 'notifications.send', 'projects.read', 'goals.read', 'tasks.read']])).rows[0].id;
  await db.query(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes)
    VALUES ('Narrow', 'pk_live_narrow', $1, $2, $2, $3)`, [hash(keys.ownerNarrow), s.owner, ['tasks.read']]);
  const inbox = randomUUID();
  await db.query('UPDATE pm.business_settings SET inbound_email_domain = $1', [RELAY]);
  await db.query(`INSERT INTO pm.inboxes (id, name, address, handler_member_id, verification_code) VALUES ($1, 'Ashley', 'ashley@agency.example', $2, 'VM-7K2Q')`, [inbox, AGENT_MEMBER]);

  // The API's rate limit, in the jsonb shape fake-postgrest serves (as the other route tests stub it).
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const storage = new FakeStorage();
  const server = await startFakePostgrest(db, { handle: (request, response, url) => storage.handler(request, response, url) });
  const resend = new FakeResend();
  const uninstall = resend.install();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url,
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
    RESEND_API_KEY: resend.apiKey,
    RESEND_INBOUND_WEBHOOK_SECRET: SVIX_SECRET,
    CRON_SECRET,
  });
  try {
    const invoices = await import('../src/app/api/v1/invoices/route');
    const teamMembers = await import('../src/app/api/v1/team-members/route');
    const notifications = await import('../src/app/api/v1/notifications/route');
    const goals = await import('../src/app/api/v1/projects/[id]/goals/route');
    const portal = await import('../src/app/api/portal/[token]/route');
    const live = await import('../src/app/api/live/state/route');
    const digest = await import('../src/app/api/internal/billing/draft-digest/route');
    const webhook = await import('../src/app/api/inbound-email/resend/route');
    const { MODULE_OFF, moduleOff } = await import('../src/lib/api/errors');
    const { deniedResponse, moduleOffFor, resolveMemberAccess } = await import('../src/lib/api/access');
    const { editApiKey } = await import('../src/lib/api/key-edit');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { toolVisible } = await import('../src/lib/mcp/server');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { applyItem } = await import('../src/lib/communications/plans');
    const { renderCommunication } = await import('../src/lib/email/client-notifications');
    const { moduleOffMessage } = await import('../src/lib/api/errors');

    type Handler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;
    const api = async (handler: Handler, method: string, path: string, key: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) as never });
      return { status: response.status, body: (await response.json().catch(() => null)) as Payload };
    };

    // withApi: a switched-off module is its own answer, not a grant problem.
    await setModules(db, allBut('billing'));
    const off = await api(invoices.GET as Handler, 'GET', '/api/v1/invoices', keys.owner);
    check('withApi: billing off is 403 MODULE_OFF, owners included', off.status === 403 && off.body?.error?.code === MODULE_OFF, off);
    check('withApi: it names the module', off.body?.error?.details?.module === 'billing' && off.body?.error?.details?.reason === 'module_off', off.body);
    check('withApi: in plain words', off.body?.error?.message === 'Client invoicing is switched off for this workspace.', off.body?.error?.message);
    const plain = await api(teamMembers.GET as Handler, 'GET', '/api/v1/team-members', keys.ownerNarrow);
    check('withApi: a missing scope stays a plain denial', plain.status === 403 && plain.body?.error?.code === 'FORBIDDEN' && plain.body?.error?.details?.reason === 'missing_key_scope', plain);
    await setModules(db, MODULE_IDS);
    const on = await api(invoices.GET as Handler, 'GET', '/api/v1/invoices', keys.owner);
    check('withApi: billing on answers', on.status === 200, on);

    // Agents: the notify channel and goals go with the module; project context stays.
    await setModules(db, allBut('agents'));
    const notify = await api(notifications.POST as Handler, 'POST', '/api/v1/notifications', keys.owner, {}, { title: 'Question', message: 'Which roof?' });
    check('agents: notify is MODULE_OFF with agents off', notify.status === 403 && notify.body?.error?.details?.module === 'agents', notify);
    const goalList = await api(goals.GET as Handler, 'GET', `/api/v1/projects/${s.project}/goals`, keys.owner, { id: s.project });
    check('agents: goals are MODULE_OFF with agents off', goalList.status === 403 && goalList.body?.error?.code === MODULE_OFF, goalList);
    const liveOff = await live.GET();
    check('agents: the public floor is not found with agents off', liveOff.status === 404, liveOff.status);
    await setModules(db, MODULE_IDS);
    const notifyOn = await api(notifications.POST as Handler, 'POST', '/api/v1/notifications', keys.owner, {}, { title: 'Question', message: 'Which roof?' });
    check('agents: notify works with agents on', notifyOn.status === 201, notifyOn);

    // The public portal: off is an unknown link; each section needs its own module.
    const openPortal = async () => {
      const response = await portal.GET(new NextRequest(`http://localhost/api/portal/${s.token}`), { params: Promise.resolve({ token: s.token }) });
      return { status: response.status, body: (await response.json()) as Payload };
    };
    await setModules(db, allBut('portal'));
    const portalOff = await openPortal();
    check('portal: off answers like an unknown link', portalOff.status === 404 && portalOff.body?.error === 'Portal not found', portalOff);
    await setModules(db, MODULE_IDS);
    const portalOn = await openPortal();
    check('portal: on shows invoices and hours', portalOn.status === 200 && portalOn.body.settings.show_invoices === true && portalOn.body.invoices.length === 1 && portalOn.body.settings.show_hours === true, portalOn.body?.settings);
    await setModules(db, allBut('billing'));
    const noBilling = await openPortal();
    check('portal: billing off leaves out invoices and money', noBilling.status === 200 && noBilling.body.settings.show_invoices === false && noBilling.body.invoices.length === 0 && noBilling.body.billing === null, { settings: noBilling.body?.settings, billing: noBilling.body?.billing });
    check('portal: billing off keeps hours', noBilling.body?.settings?.show_hours === true, noBilling.body?.settings);
    await setModules(db, allBut('time'));
    const noTime = await openPortal();
    check('portal: time off leaves out hours', noTime.status === 200 && noTime.body.settings.show_hours === false && noTime.body.hours.entries.length === 0, noTime.body?.settings);
    await setModules(db, allBut('credentials'));
    const noCreds = await openPortal();
    check('portal: credentials off leaves out client logins', noCreds.body?.settings?.show_credentials === false, noCreds.body?.settings);
    await setModules(db, MODULE_IDS);

    // Client email: everything but the invoice leads to the portal; invoices and budget figures are billing's.
    type CommType = Parameters<typeof renderCommunication>[1];
    const render = async (type: string) => {
      const result = await renderCommunication(s.project, type as CommType) as { error?: string; subject?: string };
      return { error: result.error ?? null, subject: result.subject ?? null };
    };
    const BILLING_EMAILS = ['invoice', 'budget_threshold', 'dollar_interval', 'budget_extended'];
    await setModules(db, allBut('portal'));
    for (const type of ['project_summary', 'portal_welcome']) {
      const result = await render(type);
      check(`client email: portal off refuses ${type}`, result.error === moduleOffMessage('portal'), result);
    }
    await setModules(db, allBut('billing'));
    for (const type of BILLING_EMAILS) {
      const result = await render(type);
      check(`client email: billing off refuses ${type}`, result.error === moduleOffMessage('billing'), result);
    }
    await setModules(db, allBut('contacts'));
    for (const type of ['project_summary', 'portal_welcome', ...BILLING_EMAILS]) {
      const result = await render(type);
      check(`client email: contacts off refuses ${type}`, result.error === moduleOffMessage('contacts'), result);
    }
    const portalNoContacts = await openPortal();
    check('portal: contacts off still opens the portal', portalNoContacts.status === 200 && portalNoContacts.body.settings.show_hours === true, portalNoContacts.status);
    await setModules(db, allBut('portal'));
    const invoiceNoPortal = await renderCommunication(s.project, 'invoice', {}, { invoiceId: s.invoice }) as { error?: string; html?: string; text?: string };
    check('client email: portal off still sends the invoice, with no portal link',
      !invoiceNoPortal.error && !!invoiceNoPortal.html && !`${invoiceNoPortal.html}${invoiceNoPortal.text}`.includes(`/portal/${s.token}`),
      invoiceNoPortal.error ?? 'portal link present');
    await setModules(db, MODULE_IDS);
    const invoiceWithPortal = await renderCommunication(s.project, 'invoice', {}, { invoiceId: s.invoice }) as { error?: string; html?: string };
    check('client email: portal on links the invoice in the portal', !invoiceWithPortal.error && !!invoiceWithPortal.html?.includes(`/portal/${s.token}`), invoiceWithPortal.error);
    await setModules(db, allBut('billing'));
    const summaryNoBilling = await render('project_summary');
    check('client email: billing off still renders the project summary', !summaryNoBilling.error && !!summaryNoBilling.subject, summaryNoBilling);
    await setModules(db, MODULE_IDS);
    for (const type of ['project_summary', 'portal_welcome']) {
      const result = await render(type);
      check(`client email: both on renders ${type}`, !result.error && !!result.subject, result);
    }
    for (const type of BILLING_EMAILS) {
      // Without an invoice or a crossed threshold these may still decline, but never for a module.
      const result = await render(type);
      check(`client email: both on lets ${type} past the module gate`, !result.error || !/switched off/.test(result.error), result);
    }

    // The morning digest: billing off is an idle success.
    await setModules(db, allBut('billing'));
    const digestOff = await digest.GET(new Request('http://localhost/api/internal/billing/draft-digest', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
    const digestBody = await digestOff.json() as Payload;
    check('cron: the draft digest sends nothing with billing off', digestOff.status === 200 && digestBody.outcome === 'module_off' && digestBody.emailed === 0, digestBody);
    await setModules(db, MODULE_IDS);

    // Mail with the Inbox off is still taken in and stored, and nothing acts on it.
    await setModules(db, allBut('inbox'));
    await asDatabaseOwner(db);
    const notificationsBefore = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.team_member_notifications')).rows[0].n;
    resend.add(await resendFixture(await readEml('owner-original.eml'), { emailId: 're_module_off', deliveredTo: [`ashley@${RELAY}`] }));
    const body = JSON.stringify({ type: 'email.received', created_at: '2026-11-20T18:00:00Z', data: { email_id: 're_module_off' } });
    const timestamp = Math.floor(Date.now() / 1000);
    const delivered = await webhook.POST(new Request('http://localhost/api/inbound-email/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': 'msg_re_module_off', 'svix-timestamp': String(timestamp), 'svix-signature': signSvix(SVIX_SECRET, 'msg_re_module_off', timestamp, body) },
      body,
    }));
    const deliveredBody = await delivered.json() as Payload;
    await asDatabaseOwner(db);
    const stored = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.messages WHERE provider_email_id = 're_module_off'")).rows[0].n;
    const plans = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.plans')).rows[0].n;
    const triage = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.triage')).rows[0].n;
    const notificationsAfter = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.team_member_notifications')).rows[0].n;
    check('inbox off: the webhook still takes the mail in', delivered.status === 200 && deliveredBody.status === 'ingested', deliveredBody);
    check('inbox off: and stores it', stored === 1, stored);
    check('inbox off: no plan, triage or notification follows', plans === 0 && triage === 0 && notificationsAfter === notificationsBefore, { plans, triage, notificationsBefore, notificationsAfter });
    await setModules(db, MODULE_IDS);

    // Key edits: a scope of an off module already on the key stays; adding one is refused.
    await setModules(db, allBut('billing'));
    const service = getServiceClient();
    const ownerAccess = await resolveMemberAccess(service, s.owner);
    check('keys: the owner access knows billing is off', !!ownerAccess && !ownerAccess.modules?.includes('billing'), ownerAccess?.modules);
    const editor = { memberId: s.owner, access: ownerAccess as AccessContext };
    const keep = await editApiKey(service, editor, ownerKey, { scopes: ['invoices.read', 'notifications.send', 'projects.read', 'goals.read', 'tasks.read'] });
    check('keys: saving a key that carries an off module\'s scope works', keep.status === 200, keep);
    const add = await editApiKey(service, editor, ownerKey, { scopes: ['invoices.read', 'finance.company.read', 'tasks.read'] });
    check('keys: adding an off module\'s scope is refused', add.status === 422 && /finance\.company\.read/.test((add.body as { error: string }).error) && !/invoices\.read/.test((add.body as { error: string }).error), add);
    await setModules(db, allBut('team_pay'));
    const noPayAccess = await resolveMemberAccess(service, s.owner);
    const addPay = await editApiKey(service, { memberId: s.owner, access: noPayAccess as AccessContext }, ownerKey, { scopes: ['invoices.read', 'payouts.manage', 'tasks.read'] });
    check('keys: with Team pay off, adding a pay scope is refused', addPay.status === 422 && /payouts\.manage/.test((addPay.body as { error: string }).error) && !/invoices\.read/.test((addPay.body as { error: string }).error), addPay);
    await setModules(db, MODULE_IDS);

    // The refusal helpers behind requireSessionAccess and the session routes.
    const ownerAll: AccessContext = { member_id: s.owner, role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
    const ownerNoBilling: AccessContext = { ...ownerAll, modules: allBut('billing') };
    check('session: moduleOffFor names the module', moduleOffFor(ownerNoBilling, ['invoices.read', 'invoices.manage']) === 'billing');
    check('session: a core alternative is no module refusal', moduleOffFor(ownerNoBilling, ['invoices.read', 'tasks.read']) === null);
    const denied = deniedResponse(ownerNoBilling, ['invoices.read']);
    const deniedBody = await denied.json() as Payload;
    check('session: the refusal carries the code and module', denied.status === 403 && deniedBody.code === MODULE_OFF && deniedBody.module === 'billing' && /switched off/.test(deniedBody.error), deniedBody);
    const ownerNoPay: AccessContext = { ...ownerAll, modules: allBut('team_pay') };
    check('session: pay and earnings name Team pay when it is off',
      moduleOffFor(ownerNoPay, ['compensation.manage', 'payouts.manage', 'earnings.own.read']) === 'team_pay');
    const payDenied = await deniedResponse(ownerNoPay, ['compensation.manage', 'payouts.manage', 'earnings.own.read']).json() as Payload;
    check('session: the pay refusal carries MODULE_OFF and team_pay', payDenied.code === MODULE_OFF && payDenied.module === 'team_pay', payDenied);
    check('session: Team pay off leaves invoices alone', moduleOffFor(ownerNoPay, ['invoices.read']) === null);
    const memberNone: AccessContext = { ...ownerAll, role: 'member', app_permissions: [], api_permissions: [], modules: [...MODULE_IDS] };
    const plainDenied = await deniedResponse(memberNone, ['invoices.read']).json() as Payload;
    check('session: a missing grant stays Forbidden', plainDenied.error === 'Forbidden' && !plainDenied.code, plainDenied);

    // MCP: a module's tools go with it; core tools stay.
    const caller = (modules: ModuleId[]) => ({ access: { ...ownerAll, modules }, scopes: PM_TOOLS.flatMap((t) => (Array.isArray(t.permission) ? t.permission : [t.permission])) as string[], readOnly: false, profile: 'generic' as never });
    const visible = (name: string, modules: ModuleId[]) => toolVisible(PM_TOOLS.find((t) => t.name === name)!, caller(modules));
    for (const name of ['notify_owner', 'list_agent_activity', 'list_project_goals', 'list_task_suggestions']) {
      check(`mcp: ${name} is listed with agents on`, visible(name, [...MODULE_IDS]));
      check(`mcp: ${name} vanishes with agents off`, !visible(name, allBut('agents')));
    }
    for (const name of ['get_project_context', 'add_project_context', 'search_tasks', 'list_reminders']) {
      check(`mcp: ${name} stays with agents off`, visible(name, allBut('agents')));
    }
    check('mcp: list_leads vanishes with leads off', !visible('list_leads', allBut('sales')));
    check('mcp: timer vanishes with time off', !visible('timer', allBut('time')));
    for (const tool of PM_TOOLS) {
      const needs = new Set((Array.isArray(tool.permission) ? tool.permission : [tool.permission]).map((p) => moduleOfPermission(p)));
      for (const route of tool.routes) {
        const owner = routeOwner(route.path.replace(/^\//, '').replace(/\{(\w+)\}/g, '[$1]'));
        if (owner?.kind !== 'module') continue;
        const covered = tool.module === owner.module || (needs.size > 0 && [...needs].every((m) => m === owner.module));
        check(`mcp: ${tool.name} needs ${owner.module}, whose route it calls`, covered, { permission: tool.permission, module: tool.module });
      }
    }

    // Plans: a lead item is never applied with Leads off.
    const salesOff: AccessContext = { ...ownerAll, modules: allBut('sales') };
    let applyError: unknown = null;
    try {
      await applyItem({ db: {} as SupabaseClient, memberId: s.owner, access: salesOff, channel: 'api', asPerson: false },
        { id: randomUUID(), thread_id: randomUUID(), inbox_id: inbox, subject: 'Hello' },
        { type: 'create_lead', name: 'Birch Partners' } as never);
    } catch (error) { applyError = error; }
    const expected = moduleOff('sales');
    check('plans: a lead item with Leads off is refused before it writes', (applyError as { code?: string } | null)?.code === expected.code
      && (applyError as { details?: Payload }).details?.module === 'sales', String(applyError));
  } finally {
    uninstall();
    await server.close();
  }
}

async function main() {
  await readerChecks();
  surfaceWalk();

  // A fresh 2.0 install (schema.sql, the app in pm). The 1.x migration itself
  // is checked on the release before it, upgraded to today (migrationChecks).
  const fromSchema = await createFullSchemaDatabase();
  const applied = await createFullSchemaDatabase();
  await asDatabaseOwner(applied);
  // The 2.0 migrations re-run on a fresh install change nothing.
  for (const later of laterMigrations().filter((m) => m.name >= PM_MOVE)) {
    await applied.exec(later.sql);
    await applied.exec(later.sql);
  }
  await staticChecks(applied);
  await migrationChecks(applied, fromSchema);
  await fromSchema.close();

  const seeded = await seed(applied);
  await rowChecks(applied, seeded);
  await routeChecks(applied, seeded);

  if (failures.length) {
    console.error(`${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`module guards: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
