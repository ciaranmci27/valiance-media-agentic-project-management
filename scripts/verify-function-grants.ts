/**
 * Function grants (20261123000400_function_grants.sql):
 * - anon (the public key in every browser) executes no app function in pm.
 * - authenticated executes exactly MEMBER_FUNCTIONS: a new pm function that
 *   forgets to say who may run it fails here.
 * - service_role still executes every function it could before.
 * - The migration on a database without it gives the same grants as a fresh
 *   install, and a second run changes nothing.
 * - Row security still works for a member: they read their project's tasks,
 *   not another project's, and save a task through pm.save_task.
 *
 *   npm run -s test:function-grants
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';

const MIGRATION = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261123000400_function_grants.sql'), 'utf8');
const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
/** The banner of the schema.sql section that mirrors the migration. */
const SECTION = '-- FUNCTION GRANTS (20261123000400_function_grants.sql)';

/**
 * What a signed-in member may execute. Add a function here only with the
 * reason it needs members: a row policy, a column default or check, a
 * SECURITY INVOKER function members call, or a browser or session RPC.
 */
const MEMBER_FUNCTIONS = [
  // Row policies.
  'can_access_file_entity', 'can_access_lead', 'can_access_project', 'can_access_task',
  'can_manage_inbox', 'can_read_activity', 'can_read_all_tasks', 'can_read_inbox',
  'can_read_message', 'can_read_task_row', 'can_see_reminder', 'current_team_member_id',
  'current_team_member_role', 'has_permission', 'module_enabled',
  'contact_is_live', 'credential_is_live', 'file_entity_is_live', 'invoice_is_live',
  'lead_is_live', 'portal_update_is_live', 'project_is_live', 'retainer_is_live',
  'task_is_live', 'time_entry_is_live',
  // Column defaults and check constraints.
  'workspace_currency', 'email_inbox_verification_code', 'email_is_address',
  'email_is_hostname', 'email_domain_is_public',
  // Browser and session RPCs.
  'save_task', 'convert_lead', 'requeue_webhook_delivery', 'mark_task_seen',
  'mark_tasks_seen', 'my_task_updates', 'agent_analytics_window',
  'save_project_invoice_with_allocations', 'project_invoice_payments',
  'record_invoice_payment', 'remove_invoice_payment', 'save_project_retainer',
  'schedule_retainer_amount', 'set_retainer_shares', 'generate_retainer_period',
  'retainer_due_periods', 'save_project_billing_plan', 'billing_forecast',
  'set_invoice_line_shares', 'list_trash', 'soft_delete_record', 'restore_record',
  'suggest_project_invoice_number', 'retainer_accruing_lines', 'set_credential_members',
  'review_time_entries', 'record_team_member_payout', 'set_task_parent',
  // Called by agent_analytics_window, which runs as the caller.
  'agent_analytics_int', 'agent_analytics_num', 'agent_analytics_ts',
  // Read-only, scoped to the caller, kept for installs' own code.
  'is_admin', 'get_team_directory', 'get_my_access_context',
  'get_accessible_time_entries', 'get_accessible_credential_metadata', 'invoice_hours_draft',
].sort();

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

type Grant = { name: string; sig: string; anon: boolean; auth: boolean; svc: boolean };

/** Every non-trigger pm function not owned by an extension, with who may execute it. */
async function grants(db: PGlite): Promise<Grant[]> {
  await db.exec('RESET ROLE');
  return (await db.query<Grant>(`
    SELECT p.proname name, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) sig,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') svc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pm' AND p.prokind IN ('f', 'p')
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 2`)).rows;
}

const key = (g: Grant) => `${g.sig} anon=${g.anon} auth=${g.auth} svc=${g.svc}`;

async function main() {
  check('schema.sql carries the function grants section', SCHEMA.includes(SECTION));

  // Before: schema.sql without its function grants section (what a database
  // held before the migration), keeping the sections after it, which lock
  // down their own functions. After: the shipped schema.sql.
  const BANNER = '\n-- ============================================================';
  const sectionStart = SCHEMA.lastIndexOf('\n', SCHEMA.indexOf(SECTION) - 2);
  const sectionBannerEnd = SCHEMA.indexOf(BANNER, SCHEMA.indexOf(SECTION));
  const nextSection = sectionBannerEnd < 0 ? -1 : SCHEMA.indexOf(BANNER, sectionBannerEnd + BANNER.length);
  const beforeSql = SCHEMA.includes(SECTION)
    ? SCHEMA.slice(0, sectionStart) + (nextSection < 0 ? '' : SCHEMA.slice(nextSection))
    : SCHEMA;
  const before = await createFullSchemaDatabase({ schemaSql: beforeSql });
  const beforeGrants = await grants(before);
  const fresh = await createFullSchemaDatabase();
  const freshGrants = await grants(fresh);

  // 1. anon executes nothing.
  const anon = freshGrants.filter((g) => g.anon).map((g) => g.sig);
  check('anon executes no pm function', anon.length === 0, anon.slice(0, 10));

  // 2. authenticated executes exactly the list.
  const extra = [...new Set(freshGrants.filter((g) => g.auth && !MEMBER_FUNCTIONS.includes(g.name)).map((g) => g.sig))];
  check('authenticated executes no function outside the member list (revoke it, or add it here with its reason)', extra.length === 0, extra);
  const missing = MEMBER_FUNCTIONS.filter((name) => !freshGrants.some((g) => g.name === name && g.auth));
  check('authenticated executes every function in the member list', missing.length === 0, missing);
  const unknown = MEMBER_FUNCTIONS.filter((name) => !freshGrants.some((g) => g.name === name));
  check('every function in the member list exists', unknown.length === 0, unknown);

  // 3. service_role keeps everything it had.
  const lost = beforeGrants.filter((b) => b.svc && !freshGrants.some((g) => g.sig === b.sig && g.svc)).map((b) => b.sig);
  check('service_role still executes every function it could before', lost.length === 0, lost);
  check('the before copy really had functions open to anon (the comparison means something)', beforeGrants.some((g) => g.anon));

  // 4. The migration on the before state equals a fresh install, twice over.
  await before.exec(MIGRATION);
  const migrated = (await grants(before)).map(key);
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const freshKeys = freshGrants.map(key);
  check('migration: the same grants as a fresh install', diff(migrated, freshKeys).length === 0 && diff(freshKeys, migrated).length === 0,
    [...diff(migrated, freshKeys), ...diff(freshKeys, migrated)].slice(0, 10));
  await before.exec(MIGRATION);
  check('migration: a second run changes nothing', JSON.stringify((await grants(before)).map(key)) === JSON.stringify(migrated));
  await before.close();

  // 5. New functions: default privileges grant nothing to anon or members in
  // pm, and nothing to anon in pm_custom.
  const defaults = (await fresh.query<{ schema: string; acl: string }>(`
    SELECT d.defaclnamespace::regnamespace::text schema, d.defaclacl::text acl FROM pg_default_acl d
    WHERE d.defaclobjtype = 'f' AND d.defaclnamespace IN ('pm'::regnamespace, 'pm_custom'::regnamespace)`)).rows;
  const pmDefault = defaults.find((d) => d.schema === 'pm')?.acl ?? '';
  const customDefault = defaults.find((d) => d.schema === 'pm_custom')?.acl ?? '';
  check('pm: new functions are not granted to anon or authenticated', !/\b(anon|authenticated)=X/.test(pmDefault), pmDefault);
  check('pm_custom: new functions are not granted to anon, still to authenticated', !/\banon=X/.test(customDefault) && /\bauthenticated=X/.test(customDefault), customDefault);

  // 6. The anon key in practice: no function, but the public brand still reads.
  await fresh.exec('SET ROLE anon');
  let anonError = '';
  try {
    await fresh.query('SELECT pm.is_admin()');
  } catch (error) {
    anonError = (error as Error).message;
  }
  check('anon: calling a pm function is refused', /permission denied/.test(anonError), anonError);
  let brandError = '';
  try {
    await fresh.query('SELECT 1 FROM pm.workspace_brand');
  } catch (error) {
    brandError = (error as Error).message;
  }
  check('anon: the public workspace brand still reads', brandError === '', brandError);

  // 7. A member: row policies and pm.save_task still work.
  const OWNER = '00000000-0000-0000-0000-0000000000f1';
  const MEMBER = '00000000-0000-0000-0000-0000000000f2';
  const q = async <T>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  await fresh.exec('RESET ROLE');
  await fresh.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'owner@example.com'), ('${MEMBER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM pm.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER)!.id;
  await fresh.query(`UPDATE pm.team_members SET role = 'member' WHERE id = $1`, [member]);
  await fresh.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, k, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_all']) AS k`, [member]);
  const mine = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Acme') RETURNING id"))[0].id;
  const theirs = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex Motor Coaches') RETURNING id"))[0].id;
  await fresh.query('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [mine, member]);
  await fresh.query("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Redesign the homepage', $3), ($2, 'Fleet brochure', $3)", [mine, theirs, owner]);

  await actAs(fresh, MEMBER);
  const projects = (await q<{ name: string }>('SELECT name FROM pm.projects ORDER BY name')).map((p) => p.name);
  check('member: reads the project they are on, not the other', JSON.stringify(projects) === JSON.stringify(['Acme']), projects);
  const tasks = (await q<{ title: string }>('SELECT title FROM pm.tasks ORDER BY title')).map((t) => t.title);
  check('member: reads their project\'s tasks, not the other\'s', JSON.stringify(tasks) === JSON.stringify(['Redesign the homepage']), tasks);
  const saved = (await q<{ result: { task?: { id?: string } } }>('SELECT pm.save_task(NULL, $1::jsonb) AS result',
    [JSON.stringify({ project_id: mine, title: 'Write the case study', created_by: member })]))[0]?.result;
  const savedId = saved?.task?.id;
  check('member: creates a task through pm.save_task', typeof savedId === 'string', saved);
  await q('SELECT pm.save_task($1, $2::jsonb)', [savedId, JSON.stringify({ title: 'Write the case study draft' })]);
  const renamed = await q<{ title: string }>('SELECT title FROM pm.tasks WHERE id = $1', [savedId]);
  check('member: updates the task through pm.save_task', renamed[0]?.title === 'Write the case study draft', renamed);
  let refused = '';
  try {
    await q('SELECT pm.save_task(NULL, $1::jsonb)', [JSON.stringify({ project_id: theirs, title: 'Sneak in', created_by: member })]);
  } catch (error) {
    refused = (error as Error).message;
  }
  check('member: cannot save a task on a project they are not on', /row-level security|policy/i.test(refused), refused);
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
