/**
 * Table grants (20261125000600_table_grants.sql):
 * - anon (the public key in every browser) holds nothing on a pm table, view
 *   or sequence, except SELECT on pm.workspace_brand.
 * - authenticated holds exactly MEMBER_TABLES: a table or view that gains a
 *   privilege for members (a new table on default grants, a stray GRANT)
 *   fails here until it is on the list with its reason. Never TRUNCATE,
 *   REFERENCES, TRIGGER or MAINTAIN.
 * - Every command a member row policy allows is still granted, so nothing
 *   the previous release did as a member stops working.
 * - service_role keeps every privilege it had.
 * - The migration on a database without it gives the same grants as a fresh
 *   install, and a second run changes nothing.
 * - Default privileges give new pm tables nothing for anon.
 *
 *   npm run -s test:table-grants
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';

const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_FILE = '20261125000600_table_grants.sql';
const MIGRATION = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
/** The migrations after it, in order. */
const LATER_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql') && file > MIGRATION_FILE).sort()
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
/** The banner of the schema.sql section that mirrors the migration. */
const SECTION = '-- TABLE GRANTS (20261125000600_table_grants.sql)';

const ALL = 'SELECT,INSERT,UPDATE,DELETE';
const NO_DELETE = 'SELECT,INSERT,UPDATE';

/**
 * What a signed-in member may do on each pm table or view, at table level.
 * Add a table here only with the reason members need it: a row policy for
 * authenticated that allows the command, used by the browser, the session
 * client, a SECURITY INVOKER function or view, or Realtime (which needs
 * SELECT). Anything not listed holds nothing.
 */
const MEMBER_TABLES: Record<string, string> = {
  // Read only: the row policy is SELECT; writes go through server routes on
  // the service role or SECURITY DEFINER functions.
  activities: 'SELECT', agent_health: 'SELECT', agent_health_history: 'SELECT',
  agent_owner_groups: 'SELECT', agent_owners: 'SELECT', agent_runs: 'SELECT',
  analytics_tracking_starts: 'SELECT', answers: 'SELECT', api_audit_log: 'SELECT',
  api_keys: 'SELECT', attachments: 'SELECT', conversation_projects: 'SELECT',
  conversations: 'SELECT', group_members: 'SELECT', groups: 'SELECT',
  // Initiatives and their logs: written by the server; members read them
  // (row policies initiatives_select, initiative_entries_select) and live sync needs SELECT.
  initiative_entries: 'SELECT', initiatives: 'SELECT',
  ignored_addresses: 'SELECT', inbox_handlers: 'SELECT', invoice_payments: 'SELECT',
  maintenance_runs: 'SELECT', meetings: 'SELECT', member_identities: 'SELECT',
  message_candidates: 'SELECT', message_endpoints: 'SELECT', messages: 'SELECT',
  own_domains: 'SELECT', participants: 'SELECT', permission_modules: 'SELECT',
  plan_items: 'SELECT', plans: 'SELECT', portal_events: 'SELECT',
  project_agents: 'SELECT', project_billing_plans: 'SELECT',
  project_billing_runs: 'SELECT', project_budget_history: 'SELECT',
  questions: 'SELECT', reply_drafts: 'SELECT', reply_points: 'SELECT',
  sender_rules: 'SELECT', task_events: 'SELECT', task_files: 'SELECT',
  task_links: 'SELECT', task_reopens: 'SELECT', task_reviews: 'SELECT',
  task_template_runs: 'SELECT', task_templates: 'SELECT',
  team_member_share_earnings: 'SELECT', trash_events: 'SELECT', triage: 'SELECT',
  webhook_events: 'SELECT', workspace_modules: 'SELECT',
  // The brand: the sign-in page reads it before anyone signs in (anon too).
  workspace_brand: 'SELECT',
  // Views run as the caller (security_invoker): read only.
  agent_run_feed: 'SELECT', agent_run_rows: 'SELECT', conversation_participants: 'SELECT',
  group_member_counts: 'SELECT', project_agent_counts: 'SELECT',
  task_template_run_stats: 'SELECT',
  // A full row policy (ALL, or all four commands) and no delete guard: the
  // browser store and pm.save_task, pm.convert_lead (SECURITY INVOKER) write
  // these as the member.
  agent_activities: ALL, agent_billing_gap_reviews: ALL, business_settings: ALL,
  client_addresses: ALL, client_domains: ALL, contact_emails: ALL, endpoints: ALL,
  inbox_access: ALL, inboxes: ALL, invoice_line_shares: ALL,
  invoice_time_entry_allocations: ALL, lead_contacts: ALL, lead_members: ALL,
  portal_settings: ALL, project_contacts: ALL, project_context: ALL,
  project_credential_members: ALL, project_goals: ALL, project_members: ALL,
  project_retainer_periods: ALL, project_retainer_shares: ALL, provider_plans: ALL,
  role_permissions: ALL, smtp_accounts: ALL, task_acceptance_criteria: ALL,
  task_assignees: ALL, task_dependencies: ALL, task_suggestions: ALL,
  team_member_earning_adjustments: ALL, team_member_hourly_rates: ALL,
  team_member_payout_allocations: ALL, team_member_payouts: ALL,
  team_member_permissions: ALL, time_entry_tasks: ALL, webhook_endpoints: ALL,
  // A full row policy, but forbid_hard_delete refuses every DELETE: rows go
  // to Trash through pm.soft_delete_record.
  client_communications: NO_DELETE, contacts: NO_DELETE, entity_files: NO_DELETE,
  lead_fields: NO_DELETE, lead_interactions: NO_DELETE, lead_proposals: NO_DELETE,
  leads: NO_DELETE, portal_update_attachments: NO_DELETE, portal_updates: NO_DELETE,
  project_credentials: NO_DELETE, project_hourly_rates: NO_DELETE,
  project_invoices: NO_DELETE, project_retainer_amounts: NO_DELETE,
  project_retainers: NO_DELETE, reminders: NO_DELETE, task_comments: NO_DELETE,
  task_subtasks: NO_DELETE, tasks: NO_DELETE, team_members: NO_DELETE,
  // Partial row policies.
  task_views: 'SELECT,INSERT,UPDATE', // pm.mark_task_seen(s) upsert the member's own look
  team_member_notifications: 'SELECT,UPDATE,DELETE', // read, mark read, dismiss your own
  member_snoozes: ALL, // a member's own snoozes (row policy member_snoozes_own); live sync needs SELECT
  webhook_deliveries: 'SELECT,UPDATE', // pm.requeue_webhook_delivery (SECURITY INVOKER)
  workspace_region: 'SELECT,INSERT,UPDATE', // an Owner sets the region
};

/**
 * Column grants members hold besides MEMBER_TABLES: reads limited to the
 * non-financial columns (rates and pay stay server-side).
 */
const MEMBER_COLUMN_SELECT = ['projects', 'project_time_entries'];

const ANON_TABLES: Record<string, string> = { workspace_brand: 'SELECT' };

const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

type Held = { name: string; kind: string; role: string; priv: string; level: 'table' | 'column' };

/** Every privilege anon, authenticated and PUBLIC hold on pm relations, at table and column level. */
async function held(db: PGlite): Promise<Held[]> {
  await db.exec('RESET ROLE');
  const rels = (await db.query<{ oid: number; name: string; kind: string }>(`
    SELECT c.oid, c.relname name, c.relkind kind FROM pg_class c
    WHERE c.relnamespace = 'pm'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY 2`)).rows;
  const out: Held[] = [];
  for (const role of ['anon', 'authenticated']) {
    const rows = (await db.query<{ name: string; kind: string; priv: string; tbl: boolean; col: boolean }>(`
      SELECT c.relname name, c.relkind kind, p priv,
        has_table_privilege($1, c.oid, p) tbl,
        CASE WHEN p = ANY ($3::text[]) THEN has_any_column_privilege($1, c.oid, p) ELSE false END col
      FROM pg_class c CROSS JOIN unnest($2::text[]) p
      WHERE c.oid = ANY ($4::oid[])`, [role, TABLE_PRIVILEGES, COLUMN_PRIVILEGES, rels.map((r) => r.oid)])).rows;
    for (const r of rows) {
      if (r.tbl) out.push({ name: r.name, kind: r.kind, role, priv: r.priv, level: 'table' });
      else if (r.col) out.push({ name: r.name, kind: r.kind, role, priv: r.priv, level: 'column' });
    }
  }
  const pub = (await db.query<{ name: string; kind: string; priv: string }>(`
    SELECT c.relname name, c.relkind kind, a.privilege_type priv FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relnamespace = 'pm'::regnamespace AND a.grantee = 0`)).rows;
  for (const r of pub) out.push({ ...r, role: 'PUBLIC', level: 'table' });
  return out;
}

/** The raw ACLs of every pm relation and the pm default privileges, to compare two databases. */
async function acls(db: PGlite): Promise<string[]> {
  await db.exec('RESET ROLE');
  const rels = (await db.query<{ line: string }>(`
    SELECT c.relname || ' ' || coalesce(c.relacl::text, '-') || ' ' ||
      coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ';' ORDER BY a.attnum)
                FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), '') line
    FROM pg_class c WHERE c.relnamespace = 'pm'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY c.relname`)).rows.map((r) => r.line);
  const defaults = (await db.query<{ line: string }>(`
    SELECT 'default ' || d.defaclobjtype::text || ' ' || d.defaclacl::text line FROM pg_default_acl d
    WHERE d.defaclnamespace = 'pm'::regnamespace ORDER BY d.defaclobjtype`)).rows.map((r) => r.line);
  return [...rels, ...defaults];
}

const split = (list: string) => list.split(',').filter(Boolean);

async function main() {
  check('schema.sql carries the table grants section', SCHEMA.includes(SECTION));

  // Before: schema.sql without its table grants section (what a database held
  // before the migration). After: the shipped schema.sql.
  const BANNER = '\n-- ============================================================';
  const sectionStart = SCHEMA.lastIndexOf('\n', SCHEMA.indexOf(SECTION) - 2);
  const sectionBannerEnd = SCHEMA.indexOf(BANNER, SCHEMA.indexOf(SECTION));
  const nextSection = sectionBannerEnd < 0 ? -1 : SCHEMA.indexOf(BANNER, sectionBannerEnd + BANNER.length);
  const beforeSql = SCHEMA.includes(SECTION)
    ? SCHEMA.slice(0, sectionStart) + (nextSection < 0 ? '' : SCHEMA.slice(nextSection))
    : SCHEMA;
  const before = await createFullSchemaDatabase({ schemaSql: beforeSql });
  const beforeHeld = await held(before);
  const fresh = await createFullSchemaDatabase();
  const freshHeld = await held(fresh);
  const label = (h: Held) => `${h.role} ${h.priv} on pm.${h.name}${h.level === 'column' ? ' (columns)' : ''}`;

  // 1. anon: only the brand.
  const anonExtra = freshHeld.filter((h) => h.role === 'anon' && !split(ANON_TABLES[h.name] ?? '').includes(h.priv)).map(label);
  check('anon holds nothing on a pm table or view but SELECT on workspace_brand', anonExtra.length === 0, anonExtra.slice(0, 15));
  const publicHeld = freshHeld.filter((h) => h.role === 'PUBLIC').map(label);
  check('PUBLIC holds nothing on a pm table or view', publicHeld.length === 0, publicHeld.slice(0, 15));

  // 2. authenticated: exactly the list.
  const memberExtra = freshHeld.filter((h) => h.role === 'authenticated' && !(h.level === 'table'
    ? split(MEMBER_TABLES[h.name] ?? '').includes(h.priv)
    : h.priv === 'SELECT' && MEMBER_COLUMN_SELECT.includes(h.name))).map(label);
  check('authenticated holds nothing outside the member list (revoke it, or add it here with its reason)', memberExtra.length === 0, memberExtra.slice(0, 15));
  const memberMissing = Object.entries(MEMBER_TABLES).flatMap(([name, privs]) => split(privs)
    .filter((priv) => !freshHeld.some((h) => h.role === 'authenticated' && h.level === 'table' && h.name === name && h.priv === priv))
    .map((priv) => `${priv} on pm.${name}`));
  check('authenticated holds everything on the member list (a stale entry, or a lost grant)', memberMissing.length === 0, memberMissing.slice(0, 15));
  const columnMissing = MEMBER_COLUMN_SELECT.filter((name) => !freshHeld.some((h) => h.role === 'authenticated' && h.name === name && h.priv === 'SELECT'));
  check('authenticated still reads the non-financial columns of projects and time entries', columnMissing.length === 0, columnMissing);
  const dangerous = freshHeld.filter((h) => h.role !== 'PUBLIC' && ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].includes(h.priv)).map(label);
  check('no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN for anon or authenticated', dangerous.length === 0, dangerous.slice(0, 15));

  // 3. Every command a member row policy allows is still granted (less DELETE
  // where forbid_hard_delete refuses it, and the column-granted tables).
  await fresh.exec('RESET ROLE');
  const policies = (await fresh.query<{ name: string; cmd: string }>(`
    SELECT tablename name, cmd FROM pg_policies
    WHERE schemaname = 'pm' AND permissive = 'PERMISSIVE' AND 'authenticated' = ANY (roles)`)).rows;
  const guarded = new Set((await fresh.query<{ name: string }>(`
    SELECT DISTINCT c.relname name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'pm'::regnamespace AND t.tgfoid = 'pm.forbid_hard_delete'::regproc`)).rows.map((r) => r.name));
  const refused = policies.flatMap((p) => (p.cmd === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [p.cmd]).map((priv) => ({ name: p.name, priv })))
    .filter(({ name, priv }) => !MEMBER_COLUMN_SELECT.includes(name) && !(priv === 'DELETE' && guarded.has(name)))
    .filter(({ name, priv }) => !freshHeld.some((h) => h.role === 'authenticated' && h.name === name && h.priv === priv))
    .map(({ name, priv }) => `${priv} on pm.${name}`);
  check('every command a member row policy allows is still granted', refused.length === 0, [...new Set(refused)].slice(0, 15));
  const rlsOff = (await fresh.query<{ relname: string }>(`
    SELECT relname FROM pg_class WHERE relnamespace = 'pm'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity`)).rows.map((r) => r.relname);
  check('every pm table has row security on', rlsOff.length === 0, rlsOff);

  // 4. Sequences: anon nothing, members no setval.
  const sequences = (await fresh.query<{ name: string; anon: boolean; auth_update: boolean }>(`
    SELECT c.relname name,
      has_sequence_privilege('anon', c.oid, 'USAGE') OR has_sequence_privilege('anon', c.oid, 'SELECT') OR has_sequence_privilege('anon', c.oid, 'UPDATE') anon,
      has_sequence_privilege('authenticated', c.oid, 'UPDATE') auth_update
    FROM pg_class c WHERE c.relnamespace = 'pm'::regnamespace AND c.relkind = 'S'`)).rows;
  check('anon holds nothing on a pm sequence', !sequences.some((s) => s.anon), sequences.filter((s) => s.anon).map((s) => s.name));
  check('authenticated cannot setval a pm sequence', !sequences.some((s) => s.auth_update), sequences.filter((s) => s.auth_update).map((s) => s.name));

  // 5. service_role keeps everything it had.
  const svc = async (db: PGlite) => (await db.query<{ k: string }>(`
    SELECT c.relname || ' ' || p k FROM pg_class c CROSS JOIN unnest($1::text[]) p
    WHERE c.relnamespace = 'pm'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege('service_role', c.oid, p)`, [TABLE_PRIVILEGES])).rows.map((r) => r.k);
  const svcBefore = await svc(before);
  const svcAfter = new Set(await svc(fresh));
  const svcLost = svcBefore.filter((k) => !svcAfter.has(k));
  check('service_role keeps every table privilege it had', svcLost.length === 0, svcLost.slice(0, 10));
  check('the before copy really over-granted (the comparison means something)',
    beforeHeld.some((h) => h.role === 'anon' && h.name === 'tasks' && h.priv === 'TRUNCATE'));

  // 6. The migration on the before state equals a fresh install, twice over.
  // The releases after it run after it, as an upgrade runs them (they grant
  // members what their own new tables need), and re-run safely.
  const upgrade = async () => {
    await before.exec(MIGRATION);
    for (const sql of LATER_MIGRATIONS) await before.exec(sql);
  };
  await upgrade();
  const migrated = await acls(before);
  const freshAcls = await acls(fresh);
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  check('migration: the same grants as a fresh install', diff(migrated, freshAcls).length === 0 && diff(freshAcls, migrated).length === 0,
    [...diff(migrated, freshAcls), ...diff(freshAcls, migrated)].slice(0, 10));
  await upgrade();
  check('migration: a second run changes nothing', JSON.stringify(await acls(before)) === JSON.stringify(migrated));
  await before.close();

  // 7. New tables in pm: nothing for anon, no TRUNCATE for members.
  await fresh.exec('CREATE TABLE pm.zz_table_grants_probe (id int PRIMARY KEY); CREATE SEQUENCE pm.zz_table_grants_probe_seq');
  const probe = (await fresh.query<{ anon: boolean; trunc: boolean; seq_anon: boolean; seq_update: boolean }>(`
    SELECT has_table_privilege('anon', 'pm.zz_table_grants_probe', 'SELECT') OR has_table_privilege('anon', 'pm.zz_table_grants_probe', 'INSERT') anon,
      has_table_privilege('authenticated', 'pm.zz_table_grants_probe', 'TRUNCATE') OR has_table_privilege('authenticated', 'pm.zz_table_grants_probe', 'TRIGGER') trunc,
      has_sequence_privilege('anon', 'pm.zz_table_grants_probe_seq', 'USAGE') seq_anon,
      has_sequence_privilege('authenticated', 'pm.zz_table_grants_probe_seq', 'UPDATE') seq_update`)).rows[0];
  check('a new pm table gives anon nothing', !probe.anon);
  check('a new pm table gives members no TRUNCATE or TRIGGER', !probe.trunc);
  check('a new pm sequence gives anon nothing, members no setval', !probe.seq_anon && !probe.seq_update);
  await fresh.exec('DROP TABLE pm.zz_table_grants_probe; DROP SEQUENCE pm.zz_table_grants_probe_seq');

  // 8. In practice.
  const OWNER = '00000000-0000-0000-0000-0000000000e1';
  const MEMBER = '00000000-0000-0000-0000-0000000000e2';
  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const errorOf = async (sql: string, params: unknown[] = []) => {
    try {
      await fresh.query(sql, params);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };
  await fresh.exec('RESET ROLE');
  await fresh.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'owner@example.com'), ('${MEMBER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM pm.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER)!.id;
  await fresh.query(`UPDATE pm.team_members SET role = 'member' WHERE id = $1`, [member]);
  await fresh.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, k, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_all']) AS k`, [member]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Acme') RETURNING id"))[0].id;
  await fresh.query('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, member]);
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Redesign the homepage', $2) RETURNING id", [project, owner]))[0].id;
  await fresh.query("INSERT INTO pm.team_member_notifications (user_id, title) VALUES ($1, 'You have a task')", [member]);

  await fresh.exec('RESET ROLE');
  await fresh.exec('SET ROLE anon');
  check('anon: the public workspace brand still reads', (await errorOf('SELECT 1 FROM pm.workspace_brand')) === '');
  check('anon: reading tasks is refused', /permission denied/.test(await errorOf('SELECT 1 FROM pm.tasks')));
  check('anon: truncating tasks is refused', /permission denied/.test(await errorOf('TRUNCATE pm.tasks')));
  check('anon: inserting a team member is refused', /permission denied/.test(await errorOf("INSERT INTO pm.team_members (name) VALUES ('Intruder')")));

  await actAs(fresh, MEMBER);
  const titles = (await q<{ title: string }>('SELECT title FROM pm.tasks')).map((t) => t.title);
  check('member: still reads their project\'s tasks', JSON.stringify(titles) === JSON.stringify(['Redesign the homepage']), titles);
  const saved = (await q<{ result: { task?: { id?: string } } }>('SELECT pm.save_task(NULL, $1::jsonb) AS result',
    [JSON.stringify({ project_id: project, title: 'Write the case study', created_by: member })]))[0]?.result;
  check('member: still creates a task through pm.save_task', typeof saved?.task?.id === 'string', saved);
  check('member: marking a task seen still works', (await errorOf('SELECT pm.mark_task_seen($1)', [task])) === '');
  check('member: marking a notification read still works',
    (await errorOf('UPDATE pm.team_member_notifications SET is_read = true WHERE user_id = $1', [member])) === '');
  check('member: truncating tasks is refused', /permission denied/.test(await errorOf('TRUNCATE pm.tasks')));
  check('member: a hard delete of a task is refused', /permission denied/.test(await errorOf('DELETE FROM pm.tasks WHERE id = $1', [task])));
  check('member: writing the webhook outbox directly is refused',
    /permission denied/.test(await errorOf("INSERT INTO pm.webhook_events (event_id, sequence, event_type, payload) VALUES ('evt_probe', 1, 'task.created', '{}')")));
  await fresh.close();

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
