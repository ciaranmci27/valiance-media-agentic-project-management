/**
 * 2.0: the app in its own schema.
 * - A fresh 2.0 install and a 1.x install after the move are the same in
 *   schema pm (tables, columns, constraints, indexes, triggers, policies,
 *   views, functions and their bodies, effective grants, realtime) and in
 *   their pm- storage policies.
 * - Installing 2.0 into a database that already holds another app (its own
 *   public.team_members, is_admin, app_migrations, a custom schema, a trigger
 *   on auth.users, a webhook-retries job, an avatars bucket) changes nothing
 *   outside pm and pm_custom except the app's own prefixed names.
 * - The move leaves another app's objects in public alone, bridges every
 *   moved table and API function for the previous version (row security
 *   intact), names no old schema in any body, and is safe to run twice.
 *
 *   npm run -s test:pm-schema
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsFrom, applySchema, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';
import { diffSnapshots, pmSnapshot, type Snapshot } from './lib/pm-catalog';
import { MOVE_MIGRATION, schema1x } from './release/pm-schema';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

const FRESH = readFileSync(join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const MIGRATION = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MOVE_MIGRATION), 'utf8');

function source1x(): string {
  try {
    return schemaBeforeMigration(MOVE_MIGRATION);
  } catch {
    return schema1x();
  }
}

async function q<T>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

async function storagePolicies(db: PGlite): Promise<Snapshot> {
  const out: Snapshot = {};
  await db.exec('SET search_path = pm, public');
  for (const p of await q<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null }>(db,
    `SELECT policyname name, cmd, roles::text roles, qual, with_check "check" FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'pm: %'`)) {
    out[p.name] = JSON.stringify({ cmd: p.cmd, roles: p.roles, qual: p.qual, check: p.check });
  }
  await db.exec('RESET search_path');
  return out;
}

/** Everything outside pm and pm_custom, for "changed nothing else". */
async function outside(db: PGlite): Promise<Snapshot> {
  const out: Snapshot = {};
  // Every name printed in full, whatever search path the last script left.
  await db.exec('SET search_path = pg_catalog');
  const skip = `('pm', 'pm_custom', 'pg_catalog', 'information_schema', 'pg_toast')`;
  for (const r of await q<{ k: string }>(db, `SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${skip} AND n.nspname NOT LIKE 'pg_temp%'`)) out[`rel ${r.k}`] = 'y';
  for (const r of await q<{ k: string; v: string }>(db, `SELECT c.relnamespace::regnamespace || '.' || c.relname || '.' || a.attname k, format_type(a.atttypid, a.atttypmod) v FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${skip} AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','v')`)) out[`col ${r.k}`] = r.v;
  for (const r of await q<{ k: string; v: string }>(db, `SELECT p.oid::regprocedure::text k, md5(p.prosrc) v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ${skip}`)) out[`fn ${r.k}`] = r.v;
  for (const r of await q<{ k: string; v: string }>(db, `SELECT t.tgrelid::regclass || '.' || t.tgname k, pg_get_triggerdef(t.oid) v FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT tgisinternal AND n.nspname NOT IN ${skip}`)) out[`trg ${r.k}`] = r.v;
  for (const r of await q<{ k: string; v: string }>(db, `SELECT schemaname || '.' || tablename || '.' || policyname k, coalesce(qual, '') || '|' || coalesce(with_check, '') v FROM pg_policies WHERE schemaname NOT IN ${skip}`)) out[`pol ${r.k}`] = r.v;
  for (const r of await q<{ k: string; v: string }>(db, `SELECT jobname k, command v FROM cron.job`)) out[`cron ${r.k}`] = r.v;
  for (const r of await q<{ k: string }>(db, `SELECT id k FROM storage.buckets`)) out[`bucket ${r.k}`] = 'y';
  for (const r of await q<{ k: string }>(db, `SELECT nspname k FROM pg_namespace WHERE nspname NOT IN ${skip} AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'`)) out[`schema ${r.k}`] = 'y';
  for (const r of await q<{ k: string; v: string }>(db, `SELECT c.relnamespace::regnamespace || '.' || c.relname k, coalesce(c.relacl::text, '') v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${skip} AND c.relkind IN ('r','v')`)) out[`acl ${r.k}`] = r.v;
  await db.exec('RESET search_path');
  return out;
}

const DECOYS = `
  -- Another app already in this database (Acme-like).
  CREATE TABLE public.team_members (id uuid PRIMARY KEY, email text, role text, created_at timestamptz, updated_at timestamptz,
    full_name text, access_status text, permissions jsonb, disabled_at timestamptz, disabled_by uuid, avatar_url text);
  INSERT INTO public.team_members (id, email, role) VALUES ('00000000-0000-0000-0000-0000000000d1', 'hi@example.com', 'admin');
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
  CREATE TABLE public.app_migrations (id serial PRIMARY KEY, version text, ran_at timestamptz);
  INSERT INTO public.app_migrations (version) VALUES ('hi-42');
  CREATE SCHEMA custom; CREATE TABLE custom.hi_reports (id int);
  CREATE SCHEMA inventory; CREATE TABLE inventory.products (id int, sku text);
  CREATE FUNCTION public.hi_on_signup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.hi_on_signup();
  SELECT cron.schedule('webhook-retries', '* * * * *', 'SELECT 1');
  INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);
  CREATE POLICY "Admins can manage avatar files" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'avatars');
  INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('webhook_scheduler_secret', 'theirs');
  INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000d2', 'hi-user@example.com');
`;

async function main() {
  const source = source1x();

  // 1. Fresh 2.0 and moved 1.x are the same.
  const upgraded = await createFullSchemaDatabase({ schemaSql: source });
  // The runner's own table, as every 1.x install has it.
  await upgraded.exec(`CREATE TABLE public.app_migrations (name text PRIMARY KEY, kind text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()); ALTER TABLE public.app_migrations ENABLE ROW LEVEL SECURITY; INSERT INTO public.app_migrations (name, kind, checksum) VALUES ('x.sql', 'core', 'c');`);
  await applyMigrationsFrom(upgraded, MOVE_MIGRATION);
  const fresh = await createFullSchemaDatabase();
  // The runner's own table is made by the runner, not schema.sql: compared apart.
  const app = (s: Snapshot) => Object.fromEntries(Object.entries(s).filter(([key]) => !/app_migrations/.test(key)));
  const diffs = diffSnapshots(app(await pmSnapshot(fresh)), app(await pmSnapshot(upgraded)));
  check('fresh and moved: schema pm is the same', diffs.length === 0, diffs.slice(0, 10).join('\n  '));
  const storageDiffs = diffSnapshots(await storagePolicies(fresh), await storagePolicies(upgraded));
  check('fresh and moved: the pm- storage policies are the same', storageDiffs.length === 0, storageDiffs.slice(0, 6).join('\n  '));
  const counts = (await q<{ tables: number; fns: number }>(fresh, `SELECT (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'pm'::regnamespace AND relkind = 'r') tables, (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'pm'::regnamespace) fns`))[0];
  check('fresh: the app is in pm', counts.tables > 90 && counts.fns > 200, counts);

  // Bodies and bridge.
  const oldNames = await q<{ proname: string }>(upgraded, `SELECT proname FROM pg_proc WHERE pronamespace = 'pm'::regnamespace AND prosrc ~ '\\m(public|communications)\\.(?!(read|manage)'')'`);
  check('moved: no function body still names public or communications', oldNames.length === 0, oldNames);
  const views = await q<{ name: string; invoker: boolean; comment: string | null }>(upgraded, `
    SELECT c.relnamespace::regnamespace || '.' || c.relname name, coalesce(c.reloptions::text, '') LIKE '%security_invoker=true%' invoker, obj_description(c.oid, 'pg_class') comment
    FROM pg_class c WHERE c.relnamespace IN ('public'::regnamespace, 'communications'::regnamespace) AND c.relkind = 'v'`);
  check('bridge: a view for every moved table', views.length >= counts.tables - 1, views.length);
  check('bridge: every view runs as the caller (row security applies)', views.every((v) => v.invoker), views.filter((v) => !v.invoker).map((v) => v.name));
  check('bridge: every view is marked for removal in 2.1', views.every((v) => v.comment === 'pm-2.0 bridge'));
  const wrappers = await q<{ name: string; secdef: boolean; comment: string | null }>(upgraded, `
    SELECT p.oid::regprocedure::text name, p.prosecdef secdef, obj_description(p.oid, 'pg_proc') comment FROM pg_proc p
    WHERE p.pronamespace IN ('public'::regnamespace, 'communications'::regnamespace)`);
  check('bridge: wrappers for the API functions', wrappers.length > 50, wrappers.length);
  check('bridge: every wrapper runs as the caller and is marked', wrappers.every((w) => !w.secdef && w.comment === 'pm-2.0 bridge'), wrappers.filter((w) => w.secdef || w.comment !== 'pm-2.0 bridge').map((w) => w.name).slice(0, 5));
  // Later migrations narrow the pm functions (20261123000400_function_grants)
  // and leave the wrappers as the move made them: a wrapper runs as the
  // caller, so a grant it has beyond its function reaches nothing. What must
  // hold is that no wrapper takes away a grant its function has.
  const mismatched = await q<{ name: string }>(upgraded, `
    SELECT w.oid::regprocedure::text name FROM pg_proc w JOIN pg_proc p ON p.proname = w.proname AND p.pronamespace = 'pm'::regnamespace
      AND pg_get_function_identity_arguments(p.oid) = pg_get_function_identity_arguments(w.oid)
    WHERE w.pronamespace IN ('public'::regnamespace, 'communications'::regnamespace)
      AND EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
                  WHERE has_function_privilege(r, p.oid, 'EXECUTE') AND NOT has_function_privilege(r, w.oid, 'EXECUTE'))`);
  check('bridge: every wrapper has at least its function\'s grants', mismatched.length === 0, mismatched.slice(0, 5));
  const viewGrants = await q<{ name: string }>(upgraded, `
    SELECT v.relname name FROM pg_class v JOIN pg_class t ON t.relname = v.relname AND t.relnamespace = 'pm'::regnamespace
    WHERE v.relnamespace IN ('public'::regnamespace, 'communications'::regnamespace) AND v.relkind = 'v'
      AND EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                  WHERE has_table_privilege(r, v.oid, p) <> has_table_privilege(r, t.oid, p))`);
  check('bridge: every view has exactly its table\'s grants', viewGrants.length === 0, viewGrants.slice(0, 5));
  check('moved: the tracking table moved with the app', (await q(upgraded, `SELECT 1 FROM pg_class WHERE oid = to_regclass('pm.app_migrations')`)).length === 1);
  await applyMigrationsFrom(upgraded, MOVE_MIGRATION);
  check('moved: a second run changes nothing', diffSnapshots(app(await pmSnapshot(fresh)), app(await pmSnapshot(upgraded))).length === 0);
  const tracking = await q<{ anon: boolean; auth: boolean }>(upgraded, `SELECT has_table_privilege('anon', 'pm.app_migrations', 'SELECT') anon, has_table_privilege('authenticated', 'pm.app_migrations', 'SELECT') auth`);
  check('moved: no API role can read the tracking table', tracking[0] && !tracking[0].anon && !tracking[0].auth, tracking[0]);
  await upgraded.close();

  // Through the bridge, as a member: reads, writes and row security still work.
  const bridged = await createFullSchemaDatabase({ schemaSql: source });
  await bridged.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'owner@x.co'), ('00000000-0000-0000-0000-0000000000b2', 'out@x.co')`);
  await bridged.exec(`UPDATE public.team_members SET status = 'suspended' WHERE email = 'out@x.co'`);
  await bridged.exec(`INSERT INTO public.team_member_notifications (user_id, title) SELECT id, 'Bridge' FROM public.team_members WHERE email = 'owner@x.co'`);
  await applyMigrationsFrom(bridged, MOVE_MIGRATION);
  const as = async (who: string, sql: string) => {
    await bridged.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [who]);
    await bridged.exec('SET ROLE authenticated');
    try { return (await bridged.query(sql)).rows; } finally { await bridged.exec('RESET ROLE'); }
  };
  const ownerReads = await as('00000000-0000-0000-0000-0000000000b1', `SELECT title FROM public.team_member_notifications`);
  check('bridge: a member reads their own rows through the old name', ownerReads.length === 1, ownerReads);
  const outsiderReads = await as('00000000-0000-0000-0000-0000000000b2', `SELECT title FROM public.team_member_notifications`);
  check('bridge: someone else reads nothing through it (row security applies)', outsiderReads.length === 0, outsiderReads);
  const written = await as('00000000-0000-0000-0000-0000000000b1', `UPDATE public.team_member_notifications SET is_read = true RETURNING is_read`);
  check('bridge: a member writes through the old name, into pm', written.length === 1 && (await q<{ is_read: boolean }>(bridged, `SELECT is_read FROM pm.team_member_notifications`))[0]?.is_read === true);
  // Known gap, for the moments of a deploy: a table that grants members some
  // columns only (projects, project_time_entries) cannot be read by members
  // through a view, which names every column. The server (service role) can.
  const columnTables = await q<{ t: string }>(bridged, `SELECT DISTINCT c.relname t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'pm'::regnamespace AND a.attacl IS NOT NULL ORDER BY 1`);
  check('bridge: the known column-grant gap is only projects and project_time_entries', JSON.stringify(columnTables.map((r) => r.t)) === JSON.stringify(['project_time_entries', 'projects']), columnTables);
  await bridged.close();

  // 2. Installing 2.0 next to another app changes nothing of theirs.
  const shared = await createFullSchemaDatabase({ schemaSql: '' });
  await shared.exec(DECOYS);
  const before = await outside(shared);
  const { skipped } = await applySchema(shared, FRESH, { strict: true });
  check('shared: schema.sql installs next to another app with no error', skipped.length === 0, skipped.slice(0, 3));
  const after = await outside(shared);
  const changed = diffSnapshots(before, after, ['before', 'after']).filter((line) => !/^only in after: (bucket pm-|cron pm-|pol storage\.objects\.pm: |rel (storage|cron|auth|vault|net|public)\.\S+ S$)/.test(line));
  check('shared: nothing outside pm and pm_custom changed but the app\'s prefixed names', changed.length === 0, changed.slice(0, 8).join('\n  '));
  const theirs = await q<{ members: number; migrations: number; trigger: string }>(shared, `
    SELECT (SELECT count(*)::int FROM public.team_members) members, (SELECT count(*)::int FROM public.app_migrations) migrations,
           (SELECT tgfoid::regproc::text FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_created') trigger`);
  check('shared: their team, migrations and sign-up trigger are as they were', theirs[0].members === 1 && theirs[0].migrations === 1 && /hi_on_signup$/.test(theirs[0].trigger), theirs[0]);
  await shared.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000d3', 'new-hi-user@example.com')`);
  check('shared: their new sign-ups do not become PM members', (await q(shared, `SELECT 1 FROM pm.team_members`)).length === 0);
  await shared.close();

  // 3. The move leaves another app's objects in public alone.
  const mixed = await createFullSchemaDatabase({ schemaSql: source });
  await mixed.exec(`CREATE TABLE public.vault_secrets (id uuid PRIMARY KEY, body text); INSERT INTO public.vault_secrets VALUES ('00000000-0000-0000-0000-0000000000e1', 'theirs');
    CREATE FUNCTION public.cleanup_expired_vault_secrets() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.vault_secrets WHERE false $$;`);
  await applyMigrationsFrom(mixed, MOVE_MIGRATION);
  const left = await q<{ t: boolean; f: boolean; rows: number }>(mixed, `SELECT to_regclass('public.vault_secrets') IS NOT NULL AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.vault_secrets')) = 'r' t,
    to_regprocedure('public.cleanup_expired_vault_secrets()') IS NOT NULL f, (SELECT count(*)::int FROM public.vault_secrets) rows`);
  check('move: another app\'s table and function stay in public, untouched', left[0].t && left[0].f && left[0].rows === 1, left[0]);
  check('move: and are not in pm', (await q(mixed, `SELECT 1 FROM pg_class WHERE oid = to_regclass('pm.vault_secrets')`)).length === 0);
  await mixed.close();
  await fresh.close();

  if (failures.length) {
    console.error(`pm schema: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`pm schema: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
