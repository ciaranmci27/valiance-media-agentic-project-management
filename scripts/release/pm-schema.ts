/**
 * The 2.0 move, generated so it is reviewable and repeatable (run once, at
 * release time, from the 1.x schema):
 *
 *   npx tsx --tsconfig tsconfig.mcp-test.json scripts/release/pm-schema.ts
 *
 * 1. Lists the app's own tables, views, sequences and functions from a
 *    database built from the 1.x schema.sql.
 * 2. Writes the move migration from move-to-pm.template.sql with that list.
 * 3. Builds a 1.x database, runs the migration on it, and reads the grants
 *    it ends with.
 * 4. Rewrites the 1.x schema.sql into the 2.0 one (rules below), ending with
 *    those exact grants, and writes it over supabase/schema.sql.
 * 5. Checks a fresh 2.0 database against the moved 1.x one (scripts/lib/
 *    pm-catalog.ts) and lists any difference. test:pm-schema repeats that
 *    check on every run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchema, createFullSchemaDatabase } from '../full-schema-db';
import { diffSnapshots, pmSnapshot } from '../lib/pm-catalog';

export const MOVE_MIGRATION = '20261123000000_move_to_pm.sql';
const APP = join(__dirname, '..', '..');
const SCHEMA = join(APP, 'supabase', 'schema.sql');
const TEMPLATE = join(__dirname, 'move-to-pm.template.sql');

/** Buckets, cron jobs and Vault entries are global in Supabase: 2.0 prefixes them. */
export const BUCKETS = ['avatars', 'brand', 'entity-files', 'inbound-email', 'portal-files', 'task-files'];
export const CRON_JOBS = ['webhook-retries', 'billing-drafts', 'retainer-drafts', 'reminders-due'];

/** The 1.x schema: the committed one before the move (or the working file while it is still 1.x). */
export function schema1x(): string {
  const current = readFileSync(SCHEMA, 'utf8');
  if (/create table public\.team_members/.test(current)) return current;
  const log = execFileSync('git', ['log', '--format=%H', '-n', '1', '--', `supabase/migrations/${MOVE_MIGRATION}`], { cwd: APP, encoding: 'utf8' }).trim();
  // Not committed yet (while 2.0 is being built): the last commit still has the 1.x schema.
  const ref = log ? `${log}^` : 'HEAD';
  const text = execFileSync('git', ['show', `${ref}:./supabase/schema.sql`], { cwd: APP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!/create table public.team_members/.test(text)) throw new Error(`The schema at ${ref} is not 1.x: cannot find the schema to move from.`);
  return text;
}

/** In schema.sql, everything from this line on is later migrations' SQL, kept on regenerating. */
const AFTER_THE_MOVE = '-- @AFTER-THE-MOVE';

/** App functions that 1.x creates only when an extension is on. */
export const CONDITIONAL_FUNCTIONS = ['public.store_webhook_scheduler'];

const sqlArray = (name: string, items: string[]) =>
  `  ${name} text[] := ARRAY[\n${items.map((item) => `    '${item}'`).join(',\n')}\n  ];`;

export async function renderMigration(source: string): Promise<string> {
  const db = await createFullSchemaDatabase({ schemaSql: source });
  const relations = (await db.query<{ n: string }>(`
    SELECT n.nspname || '.' || c.relname AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'communications') AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND NOT c.relispartition
      AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
    ORDER BY CASE c.relkind WHEN 'S' THEN 2 WHEN 'v' THEN 1 WHEN 'm' THEN 1 ELSE 0 END, 1`)).rows.map((r) => r.n);
  // The runner's own table: every install has it, though schema.sql does not make it.
  if (!relations.includes('public.app_migrations')) relations.unshift('public.app_migrations');
  const functions = (await db.query<{ n: string }>(`
    SELECT DISTINCT n.nspname || '.' || p.proname AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname IN ('public', 'communications') AND d.objid IS NULL ORDER BY 1`)).rows.map((r) => r.n);
  // Made only where Supabase Vault is on (20261122090000_app_secrets.sql), so
  // the test database has none; every real install with Vault does.
  for (const fn of CONDITIONAL_FUNCTIONS) if (!functions.includes(fn)) functions.push(fn);
  functions.sort();
  await db.close();
  return readFileSync(TEMPLATE, 'utf8')
    .replace('  -- @APP_RELATIONS', sqlArray('app_relations', relations))
    .replace('  -- @APP_FUNCTIONS', sqlArray('app_functions', functions));
}

const PM_HEADER = `-- Full schema (2.0): the app lives in its own schemas, \`pm\` (core, changed
-- only by releases) and \`pm_custom\` (an install's own), so it can share a
-- Supabase project with a company's other apps. Run this in your Supabase SQL
-- Editor on a new project, or on one that already holds other apps: it
-- creates nothing in \`public\`.

CREATE SCHEMA IF NOT EXISTS pm;
CREATE SCHEMA IF NOT EXISTS pm_custom;
GRANT USAGE ON SCHEMA pm, pm_custom TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SET search_path = pm, extensions;
`;

/** The 1.x text rewritten into pm, before the grants section is added. */
export function rewriteSchema(source: string): string {
  let s = source.replace(/\r\n/g, '\n');
  // The file's own opening comment is replaced by the 2.0 header.
  s = s.replace(/^-- Full schema\n-- Run this in your Supabase SQL Editor\n/, '');
  // The communications schema and its grants: the app is one schema now
  // (the grants section at the end sets every object's grants exactly).
  s = s.replace(/^CREATE SCHEMA IF NOT EXISTS communications;\n/m, '');
  s = s.replace(/^(REVOKE ALL ON SCHEMA communications|GRANT USAGE ON SCHEMA communications|ALTER DEFAULT PRIVILEGES IN SCHEMA communications|GRANT [^\n]* ON ALL TABLES IN SCHEMA communications)[^\n]*\n/gm, '');
  // Search paths.
  s = s.replace(/search_path = communications, public/g, 'search_path = pm');
  s = s.replace(/search_path = public\b/g, 'search_path = pm');
  // Qualified names and schema literals.
  // Not the permission names communications.read and communications.manage.
  s = s.replace(/\b(public|communications)\.(?!(?:read|manage)')/g, 'pm.');
  s = s.replace(/'(public|communications)'/g, "'pm'");
  // Vault entries for webhook retries (the app_secrets name of the same
  // spelling is the app's own and keeps its name).
  s = s.replace(/'webhook_scheduler_(url|secret)'/g, "'pm_webhook_scheduler_$1'");
  s = s.replace(/(CREATE TABLE IF NOT EXISTS pm\.app_secrets[\s\S]*?\);)/, (block) => block.replace("'pm_webhook_scheduler_secret'", "'webhook_scheduler_secret'"));
  // Buckets and their storage policies.
  for (const bucket of BUCKETS) {
    s = s.split(`('${bucket}', '${bucket}'`).join(`('pm-${bucket}', 'pm-${bucket}'`);
    s = s.split(`bucket_id = '${bucket}'`).join(`bucket_id = 'pm-${bucket}'`);
  }
  s = s.replace(/((?:create|CREATE) policy|(?:drop|DROP) policy if exists|DROP POLICY IF EXISTS|CREATE POLICY) "([^"]+)"(\s+(?:on|ON) storage\.objects)/g, (_m, verb, name, rest) => `${verb} "pm: ${name.replace(/^pm: /, '')}"${rest}`);
  // Scheduled jobs.
  for (const job of CRON_JOBS) s = s.split(`'${job}'`).join(`'pm-${job}'`);
  // Fresh installs: no trigger on auth.users. The server adds members
  // (pm.add_team_member), so another app's sign-ups never touch the PM app.
  s = s.replace(/^create trigger on_auth_user_created[\s\S]*?;\n/m, '');
  return PM_HEADER + '\n' + s;
}

/** Exact grants for every object in pm, read from a database after the move. */
export async function grantsSection(source: string, migration: string): Promise<string> {
  const db = await createFullSchemaDatabase({ schemaSql: source });
  await db.exec(migration);
  const lines: string[] = [
    '',
    '-- ============================================================',
    '-- GRANTS: every object in pm, exactly (generated by scripts/release/pm-schema.ts',
    '-- from a 1.x database after the move, so fresh and upgraded installs match).',
    '-- ============================================================',
  ];
  const rels = (await db.query<{ name: string; kind: string; grants: string | null }>(`
    SELECT c.relname name, c.relkind::text kind,
      (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END || ':' || a.privilege_type, ',' ORDER BY 1)
       FROM aclexplode(c.relacl) a WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role')) grants
    FROM pg_class c WHERE c.relnamespace = 'pm'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY 1`)).rows;
  for (const r of rels) {
    const what = r.kind === 'S' ? 'SEQUENCE ' : '';
    lines.push(`REVOKE ALL ON ${what}pm.${r.name} FROM PUBLIC, anon, authenticated, service_role;`);
    const byRole = new Map<string, string[]>();
    for (const item of (r.grants ?? '').split(',').filter(Boolean)) {
      const [role, priv] = item.split(':');
      byRole.set(role, [...(byRole.get(role) ?? []), priv]);
    }
    for (const [role, privs] of byRole) lines.push(`GRANT ${privs.join(', ')} ON ${what}pm.${r.name} TO ${role};`);
  }
  // Column-level grants, after the table-level ones (a table REVOKE clears them).
  const cols = (await db.query<{ t: string; c: string; role: string; priv: string }>(`
    SELECT c.relname t, quote_ident(a.attname) c, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x.grantee)) END role, x.privilege_type priv
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
    WHERE c.relnamespace = 'pm'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated', 'service_role'))
    ORDER BY 1, 3, 4, 2`)).rows;
  const grouped = new Map<string, string[]>();
  for (const col of cols) {
    const key = `${col.priv}|${col.t}|${col.role}`;
    grouped.set(key, [...(grouped.get(key) ?? []), col.c]);
  }
  for (const [key, names] of grouped) {
    const [priv, table, role] = key.split('|');
    lines.push(`GRANT ${priv} (${names.join(', ')}) ON pm.${table} TO ${role};`);
  }
  const fns = (await db.query<{ sig: string; grants: string | null; defacl: boolean }>(`
    SELECT p.oid::regprocedure::text sig, p.proacl IS NULL defacl,
      (SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END, ',')
       FROM aclexplode(p.proacl) a WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role')) grants
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace ORDER BY 1`)).rows;
  for (const f of fns) {
    lines.push(`REVOKE ALL ON FUNCTION ${f.sig} FROM PUBLIC, anon, authenticated, service_role;`);
    const grantees = f.defacl ? ['PUBLIC'] : (f.grants ?? '').split(',').filter(Boolean);
    if (grantees.length) lines.push(`GRANT EXECUTE ON FUNCTION ${f.sig} TO ${grantees.join(', ')};`);
  }
  await db.close();
  return lines.join('\n') + '\n';
}

export async function compareFreshWithUpgraded(fresh: string, source: string, migration: string): Promise<string[]> {
  const upgraded = await createFullSchemaDatabase({ schemaSql: source });
  await upgraded.exec(migration);
  const freshDb = await createFullSchemaDatabase({ schemaSql: '' });
  const { skipped } = await applySchema(freshDb, fresh, { strict: true });
  const diffs = diffSnapshots(await pmSnapshot(freshDb), await pmSnapshot(upgraded));
  await upgraded.close();
  await freshDb.close();
  return [...skipped.map((s) => `fresh schema skipped: ${s}`), ...diffs];
}

async function main() {
  const source = schema1x();
  const migration = await renderMigration(source);
  const migrationPath = join(APP, 'supabase', 'migrations', MOVE_MIGRATION);
  writeFileSync(migrationPath, migration);
  console.log(`wrote ${MOVE_MIGRATION}`);
  // Later 2.0 migrations' sections, after the marker, are kept as written.
  const current = existsSync(SCHEMA) ? readFileSync(SCHEMA, 'utf8') : '';
  const markerAt = current.indexOf(AFTER_THE_MOVE);
  const after = markerAt >= 0 ? '\n' + current.slice(markerAt) : '';
  const generated = rewriteSchema(source) + (await grantsSection(source, migration));
  writeFileSync(SCHEMA, generated + after);
  console.log('wrote supabase/schema.sql (2.0)');
  // The later sections are checked by test:pm-schema, which applies their migrations too.
  const diffs = await compareFreshWithUpgraded(generated, source, migration);
  if (diffs.length) {
    console.error(`${diffs.length} difference(s) between a fresh 2.0 install and a moved 1.x one:`);
    for (const d of diffs.slice(0, 80)) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log('fresh 2.0 and moved 1.x match.');
}

if (require.main === module && existsSync(TEMPLATE)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
