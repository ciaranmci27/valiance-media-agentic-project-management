/**
 * Outsiders get nothing: a signed-in account with no active PM membership
 * (another app's user on a shared Supabase project, or a deactivated member)
 * must read no row and change no row in any table or view of the app's
 * schemas, through the API roles. Storage and realtime are checked on the
 * local Supabase stack (they need the real services); this covers the
 * database.
 *
 * Every table gets one row first (as the database owner, triggers and
 * foreign keys off), so "sees nothing" means something.
 *
 *   npm run -s test:outsiders
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actAs, createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';

const MIGRATION = '20261122100000_pm_schemas_and_outsiders.sql';

const SCHEMAS = ['pm'];

/**
 * Readable by any signed-in account on purpose, each for a reason. Nothing
 * here may hold a team's data.
 */
const OPEN_ON_PURPOSE: Record<string, string> = {
  'pm.workspace_brand': 'name, colour and logo for the sign-in page, which signed-out visitors see too',
  'pm.permission_modules': 'which module each permission belongs to: product metadata, the same for every install',
  'pm.role_permissions': 'what each role may do by default: product metadata, the same for every install',
  'pm.workspace_modules': 'which modules are switched on: the sign-in shell reads it before access is known',
};

let passed = 0;
const failures: string[] = [];
const notes: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

type Column = { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; is_generated: string; is_identity: string };

function sample(column: Column, attempt: number): unknown {
  const t = column.data_type;
  if (t === 'uuid') return randomUUID();
  if (t === 'boolean') return false;
  if (/int|numeric|real|double/.test(t)) return 1;
  if (t.startsWith('timestamp') || t === 'date') return '2026-01-01';
  if (t === 'time without time zone') return '09:00';
  if (t === 'interval') return '1 hour';
  if (t === 'jsonb' || t === 'json') return '{}';
  if (t === 'ARRAY') return '{}';
  if (t === 'inet') return '127.0.0.1';
  if (t === 'bytea') return '\\x00';
  if (t === 'USER-DEFINED') return null; // filled from the enum below
  return attempt === 0 ? 'x' : `x${attempt}`;
}

async function main() {
  const db = await createFullSchemaDatabase();
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  const tables = await q<{ schema: string; name: string; kind: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition ORDER BY 1, 2`, [SCHEMAS]);

  // One row per table, as the owner, with triggers and foreign keys off.
  await db.exec('SET session_replication_role = replica');
  const unseeded: string[] = [];
  for (const table of tables.filter((t) => t.kind === 'r' || t.kind === 'p')) {
    const columns = await q<Column>(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [table.schema, table.name]);
    const needed = columns.filter((c) => c.is_nullable === 'NO' && c.column_default === null && c.is_generated !== 'ALWAYS' && c.is_identity !== 'YES');
    const values = new Map<string, unknown>();
    for (const column of needed) {
      if (column.data_type === 'USER-DEFINED') {
        const label = await q<{ l: string }>(`SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder LIMIT 1`, [column.udt_name]);
        values.set(column.column_name, label[0]?.l ?? null);
      } else values.set(column.column_name, sample(column, 0));
    }
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const names = [...values.keys()];
      const sql = names.length
        ? `INSERT INTO ${table.schema}.${table.name} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`
        : `INSERT INTO ${table.schema}.${table.name} DEFAULT VALUES`;
      try {
        await db.query(sql, [...values.values()]);
        done = true;
      } catch (error) {
        const message = (error as Error).message;
        // A check constraint: take the first literal it allows for the column it names.
        const constraint = /violates check constraint "([^"]+)"/.exec(message)?.[1];
        if (constraint) {
          const def = (await q<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 LIMIT 1`, [constraint]))[0]?.d ?? '';
          const target = [...values.keys()].find((name) => def.includes(name)) ?? columns.find((c) => def.includes(c.column_name))?.column_name;
          const literal = /'([^']*)'/.exec(def)?.[1];
          if (target && literal !== undefined) { values.set(target, literal); continue; }
          if (target) { values.set(target, sample(columns.find((c) => c.column_name === target)!, attempt + 1)); continue; }
        }
        const nullColumn = /null value in column "([^"]+)"/.exec(message)?.[1];
        if (nullColumn) { values.set(nullColumn, sample(columns.find((c) => c.column_name === nullColumn)!, attempt)); continue; }
        if (/duplicate key|unique/.test(message)) { done = true; break; }
        unseeded.push(`${table.schema}.${table.name} (${message.slice(0, 90)})`);
        break;
      }
    }
  }
  await db.exec('SET session_replication_role = origin');
  if (unseeded.length) notes.push(`could not seed (checked for reads anyway): ${unseeded.join('; ')}`);

  // The outsider: an account with no membership at all.
  const outsider = randomUUID();
  await db.exec('ALTER TABLE auth.users DISABLE TRIGGER USER');
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'outsider@other-app.example')`, [outsider]);
  await db.exec('ALTER TABLE auth.users ENABLE TRIGGER USER');
  check('setup: the outsider has no team row', (await q(`SELECT 1 FROM pm.team_members WHERE auth_user_id = $1`, [outsider])).length === 0);

  for (const table of tables) {
    const name = `${table.schema}.${table.name}`;
    const seededRows = Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${name}`))[0].n);
    await actAs(db, outsider);
    let read: string;
    try {
      const n = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n);
      read = n === 0 ? 'none' : `${n} row(s)`;
    } catch (error) {
      read = /permission denied/.test((error as Error).message) ? 'denied' : `error: ${(error as Error).message.slice(0, 80)}`;
    }
    let write = 'n/a';
    if (table.kind === 'r' || table.kind === 'p' || table.kind === 'v') {
      const first = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 1`, [table.schema, table.name])).rows[0]?.c;
      // No column it may see at all: it holds no privilege on the table.
      if (!first) write = 'denied';
      else try {
        await db.exec('BEGIN');
        const r = await db.query(`UPDATE ${name} SET "${first}" = "${first}" RETURNING 1`);
        write = r.rows.length ? `updated ${r.rows.length}` : 'none';
        await db.exec('ROLLBACK');
      } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        const message = (error as Error).message;
        write = /permission denied|row-level security|cannot (update|delete)|not allowed|Only|refuse|is not updatable|soft/i.test(message) ? 'denied' : `error: ${message.slice(0, 80)}`;
      }
    }
    await actAs(db, null);
    await db.exec('RESET ROLE');
    const open = OPEN_ON_PURPOSE[name];
    const readOk = read === 'none' || read === 'denied' || (open !== undefined && !read.startsWith('error'));
    check(`read: ${name} (${read}${seededRows ? '' : ', no seed row'})`, readOk, open);
    check(`write: ${name} (${write})`, write === 'none' || write === 'denied' || write === 'n/a');
  }

  // Inserts: an outsider can create nothing.
  for (const table of tables.filter((t) => t.kind === 'r' || t.kind === 'p')) {
    const name = `${table.schema}.${table.name}`;
    await actAs(db, outsider);
    let outcome: string;
    try {
      await db.exec('BEGIN');
      await db.query(`INSERT INTO ${name} DEFAULT VALUES`);
      outcome = 'inserted';
      await db.exec('ROLLBACK');
    } catch (error) {
      await db.exec('ROLLBACK').catch(() => {});
      const message = (error as Error).message;
      // RLS and grants are checked before NOT NULL and CHECK constraints, so any
      // other error means the policy let the row through.
      // A trigger that refuses every insert (a retired table) runs before row security.
      outcome = /permission denied|row-level security|Subtasks are tasks now/.test(message) ? 'denied' : `error: ${message.slice(0, 80)}`;
    }
    await actAs(db, null);
    await db.exec('RESET ROLE');
    check(`insert: ${name} (${outcome})`, outcome === 'denied');
  }

  // Storage: every write policy for signed-in accounts needs an active membership.
  const storagePolicies = await q<{ policyname: string; cmd: string; expr: string }>(
    `SELECT policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects' AND 'authenticated' = ANY (roles)`);
  check('storage: the app has storage policies to check', storagePolicies.length >= 10, storagePolicies.length);
  for (const policy of storagePolicies) {
    check(`storage: "${policy.policyname}" (${policy.cmd}) needs a membership`, /current_team_member_id/.test(policy.expr), policy.expr);
  }

  // The 2.0 schemas exist, empty, usable by the API roles.
  const schemas = await q<{ nspname: string; usage: boolean }>(
    `SELECT nspname, has_schema_privilege('authenticated', nspname, 'USAGE') AS usage FROM pg_namespace WHERE nspname IN ('pm', 'pm_custom') ORDER BY 1`);
  check('schemas: pm and pm_custom exist and the API roles may use them', schemas.length === 2 && schemas.every((r) => r.usage), schemas);
  await db.close();

  // Upgrading: the migration on the schema before it, twice, with and
  // without an API schema list kept in the database.
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
  const listOf = async (old: Awaited<ReturnType<typeof createFullSchemaDatabase>>) =>
    (await old.query<{ c: string | null }>(`SELECT (SELECT s FROM unnest(rolconfig) s WHERE s LIKE 'pgrst.db_schemas=%') AS c FROM pg_roles WHERE rolname = 'authenticator'`)).rows[0]?.c ?? null;
  let before: string;
  try {
    before = schemaBeforeMigration(MIGRATION);
  } catch {
    // Not committed yet (while it is being written): the last commit is the schema before it.
    before = schemaAt('HEAD');
  }
  const old = await createFullSchemaDatabase({ schemaSql: before });
  await old.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOINHERIT; END IF; END $$;`);
  await old.exec("ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, communications, website'");
  await old.exec(sql);
  await old.exec(sql);
  const appended = await listOf(old);
  check('upgrade: pm and pm_custom are added once, every schema already listed is kept',
    appended === 'pgrst.db_schemas=public, graphql_public, communications, website, pm, pm_custom', appended);
  await old.exec('ALTER ROLE authenticator RESET pgrst.db_schemas');
  await old.exec(sql);
  check('upgrade: with no list in the database, it adds none (the host keeps its own)', await listOf(old) === null);
  const policy = (await old.query<{ qual: string }>(`SELECT qual FROM pg_policies WHERE tablename = 'trash_events' AND policyname = 'trash_events_select'`)).rows[0]?.qual ?? '';
  check('upgrade: the policies are replaced with the members-only ones', /current_team_member_id/.test(policy), policy);
  await old.close();

  for (const note of notes) console.log(`note: ${note}`);
  if (failures.length) {
    console.error(`outsiders: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`outsiders: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
