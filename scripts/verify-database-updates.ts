/**
 * Database updates (1.9.0): whether production deploys apply a release's
 * migrations on their own, and whether the ones a build carries landed.
 * - the mode from the host's connection string, the Owner's switch and
 *   MIGRATE_ON_DEPLOY=false;
 * - what is pending, from the build's list and the runner's record;
 * - when a build migrates (scripts/build.ts) and when the runner skips
 *   because the switch is off (scripts/db-migrate.ts --if-enabled);
 * - the Owner-only route that flips the switch, and its audit row;
 * - in the database: only an Owner changes the switch (or the personal inbox
 *   policy), Admins still edit the rest of the business row, and an existing
 *   database upgrades with the switch on.
 *
 *   npm run -s test:database-updates
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { carriedMigrations, databaseMode, databaseUpdates, pendingMigrations, recordedMigrations } from '../src/lib/updates/database';
import { getUpdates, postDatabase, type AuditEntry, type DatabaseStore, type UpdatesDeps } from '../src/lib/updates/handlers';
import { clearReleaseCache } from '../src/lib/updates/releases';
import { clearConnectionCache } from '../src/lib/updates/connection';
import { shouldMigrate } from './build';
import { envChecks, pmSchemasState } from '../src/lib/setup/checks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { automaticUpdatesOn } from './db-migrate';
import { actAs, createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';

const MIGRATION = '20261121090000_database_updates_switch.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

// ---- The mode and what is pending ------------------------------------------
function rules() {
  const url = { SUPABASE_DB_URL: 'postgres://x' };
  check('mode: no connection string is not set up', databaseMode({}, true) === 'not_set_up');
  check('mode: DATABASE_URL counts too', databaseMode({ DATABASE_URL: 'postgres://x' }, null) === 'automatic');
  check('mode: connection string and switch on is automatic', databaseMode(url, true) === 'automatic');
  check('mode: a switch not there yet counts as on', databaseMode(url, null) === 'automatic');
  check('mode: switch off is manual', databaseMode(url, false) === 'manual');
  check('mode: MIGRATE_ON_DEPLOY=false is manual whatever the switch', databaseMode({ ...url, MIGRATE_ON_DEPLOY: 'false' }, true) === 'manual');
  check('mode: MIGRATE_ON_DEPLOY=true changes nothing', databaseMode({ ...url, MIGRATE_ON_DEPLOY: 'true' }, false) === 'manual');
  check('mode: a blank connection string is not set up', databaseMode({ SUPABASE_DB_URL: '  ' }, true) === 'not_set_up');

  const carried = carriedMigrations({ PM_MIGRATIONS: 'a.sql, b.sql,,custom/c.sql' });
  check('carried: names in order, blanks dropped', JSON.stringify(carried) === JSON.stringify(['a.sql', 'b.sql', 'custom/c.sql']), carried);
  check('carried: none when the build said nothing', carriedMigrations({}).length === 0);
  check('pending: what the record lacks', JSON.stringify(pendingMigrations(carried, ['a.sql'])) === JSON.stringify(['b.sql', 'custom/c.sql']));
  check('pending: nothing when all landed', pendingMigrations(carried, ['a.sql', 'b.sql', 'custom/c.sql', 'old.sql'])?.length === 0);
  check('pending: unknown without a record', pendingMigrations(carried, null) === null);
  const state = databaseUpdates({ ...url, PM_MIGRATIONS: 'a.sql', MIGRATE_ON_DEPLOY: 'FALSE' }, { switchOn: true, applied: [] });
  check('state: puts it together', state.mode === 'manual' && state.hostOff && state.switchOn === true && state.pending?.[0] === 'a.sql', state);
  check('state: never carries the connection string', !JSON.stringify(state).includes('postgres://'));

  check('record: an empty table is no record', recordedMigrations({ data: [], error: null }) === null);
  check('record: a missing table is no record', recordedMigrations({ data: null, error: { code: 'PGRST205', message: 'Could not find the table public.app_migrations' } }) === null);
  check('record: names when there are some', JSON.stringify(recordedMigrations({ data: [{ name: 'a.sql' }], error: null })) === JSON.stringify(['a.sql']));
  let thrown = false;
  try { recordedMigrations({ data: null, error: { code: '42501', message: 'permission denied for table app_migrations' } }); } catch { thrown = true; }
  check('record: any other read error is thrown (the page says it could not read)', thrown);
  check('state: an empty record lists nothing as pending', databaseUpdates({ SUPABASE_DB_URL: 'x', PM_MIGRATIONS: 'a.sql' }, { switchOn: true, applied: recordedMigrations({ data: [], error: null }) }).pending === null);

  const wizard = (env: Record<string, string>) => envChecks(env, { crons: false }).find((item) => item.name === 'SUPABASE_DB_URL');
  check('wizard: lists the connection string as optional', wizard({})?.required === false && wizard({})?.set === false);
  check('wizard: DATABASE_URL counts as set', wizard({ DATABASE_URL: 'postgres://x' })?.set === true);
  check('wizard: and never shows the value', !JSON.stringify(envChecks({ SUPABASE_DB_URL: 'postgres://x' }, { crons: false })).includes('postgres://'));
}

// ---- When a build migrates -------------------------------------------------
function build() {
  const prod = { VERCEL_ENV: 'production', SUPABASE_DB_URL: 'postgres://x' } as unknown as NodeJS.ProcessEnv;
  check('build: production with a connection string migrates', shouldMigrate(prod));
  check('build: DATABASE_URL works too', shouldMigrate({ VERCEL_ENV: 'production', DATABASE_URL: 'postgres://x' } as unknown as NodeJS.ProcessEnv));
  check('build: previews never migrate', !shouldMigrate({ ...prod, VERCEL_ENV: 'preview' }));
  check('build: local builds never migrate', !shouldMigrate({ SUPABASE_DB_URL: 'postgres://x' } as unknown as NodeJS.ProcessEnv));
  check('build: MIGRATE_ON_DEPLOY=false stops it', !shouldMigrate({ ...prod, MIGRATE_ON_DEPLOY: 'false' }));
  check('build: no connection string, no migration', !shouldMigrate({ VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv));
  check('build: MIGRATE_ON_DEPLOY=true without one still tries (and says what is missing)', shouldMigrate({ VERCEL_ENV: 'production', MIGRATE_ON_DEPLOY: 'true' } as unknown as NodeJS.ProcessEnv));
  const source = readFileSync(join(__dirname, 'build.ts'), 'utf8');
  check('build: the runner is asked to respect the switch', source.includes("migrate(['--if-enabled'])"));
}

// ---- The route ---------------------------------------------------------------
function store(start: boolean | null, options: { failSave?: boolean } = {}) {
  let switchOn = start;
  const saves: boolean[] = [];
  const db: DatabaseStore = {
    read: async () => ({ switchOn, applied: ['a.sql'] }),
    save: async (on) => {
      if (options.failSave) return { ok: false, message: 'database said no' };
      saves.push(on);
      switchOn = on;
      return { ok: true };
    },
  };
  return { db, saves };
}

function deps(options: { role?: string; env?: Record<string, string>; database?: DatabaseStore } = {}): { deps: UpdatesDeps; audits: AuditEntry[] } {
  clearReleaseCache();
  clearConnectionCache();
  const audits: AuditEntry[] = [];
  return {
    audits,
    deps: {
      env: { SUPABASE_DB_URL: 'postgres://secret', PM_MIGRATIONS: 'a.sql,b.sql', PM_INSTALL_ROLE: 'source', ...(options.env ?? {}) },
      database: options.database,
      // No network: the release list answers empty.
      fetch: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      currentVersion: () => '1.9.0',
      now: () => new Date('2026-11-21T12:00:00Z'),
      sleep: async () => {},
      authorize: async () => ({ error: null, memberId: 'member-1', role: options.role ?? 'owner' }),
      audit: (entry) => audits.push(entry),
    },
  };
}

const post = (body: unknown, headers: Record<string, string> = { origin: 'https://pm.example.com' }) =>
  new NextRequest('https://pm.example.com/api/workspace/updates/database', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function json(response: NextResponse | Response) {
  return { status: response.status, body: await response.json() as { data?: Record<string, unknown>; error?: string } };
}

async function route() {
  const owner = store(true);
  const ok = deps({ database: owner.db });
  const off = await json(await postDatabase(post({ automatic: false }), ok.deps));
  check('route: an Owner turns it off', off.status === 200 && off.body.data?.mode === 'manual' && owner.saves[0] === false, off);
  check('route: the answer never carries the connection string', !JSON.stringify(off.body).includes('postgres://'));
  const audit = ok.audits[0];
  check('route: the change is audited, before and after', audit?.endpoint === '/api/workspace/updates/database'
    && JSON.stringify(audit.before_snapshot) === JSON.stringify({ mode: 'automatic', switchOn: true })
    && JSON.stringify(audit.after_snapshot) === JSON.stringify({ mode: 'manual', switchOn: false }), audit);
  check('route: the source install has the switch too', off.status === 200);

  const admin = store(true);
  const refused = await json(await postDatabase(post({ automatic: false }), deps({ role: 'admin', database: admin.db }).deps));
  check('route: an Admin is refused', refused.status === 403 && admin.saves.length === 0, refused);
  const cross = store(true);
  const crossSite = await json(await postDatabase(post({ automatic: false }, { origin: 'https://evil.example' }), deps({ database: cross.db }).deps));
  check('route: a cross-site request is refused', crossSite.status === 403 && cross.saves.length === 0, crossSite);
  const bad = await json(await postDatabase(post({ automatic: 'no' }), deps({ database: store(true).db }).deps));
  check('route: a body without a true or false is refused', bad.status === 400, bad);
  const demo = await json(await postDatabase(post({ automatic: false }), deps({ database: store(true).db, env: { DEMO_MODE: 'true' } }).deps));
  check('route: the demo is refused', demo.status === 403, demo);
  const failing = deps({ database: store(true, { failSave: true }).db });
  const failed = await json(await postDatabase(post({ automatic: false }), failing.deps));
  check('route: a failed save answers 500 and audits nothing', failed.status === 500 && failing.audits.length === 0, failed);
  const none = await json(await postDatabase(post({ automatic: false }), deps().deps));
  check('route: without a database store it answers 503', none.status === 503, none);

  const read = await json(await getUpdates(new NextRequest('https://pm.example.com/api/workspace/updates'), deps({ database: store(null).db }).deps));
  const database = read.body.data?.database as { mode?: string; pending?: string[] } | undefined;
  check('read: Settings > Updates gets the database state', read.status === 200 && database?.mode === 'automatic' && JSON.stringify(database.pending) === JSON.stringify(['b.sql']), read.body);
  check('read: and never the connection string', !JSON.stringify(read.body).includes('postgres://'));
}

// ---- The database ------------------------------------------------------------
async function databaseChecks() {
  const db = await createFullSchemaDatabase();
  const runner = { query: async <T>(sql: string) => (await db.query<T>(sql)).rows, exec: async (sql: string) => { await db.exec(sql); } };
  check('runner: a fresh install is on', await automaticUpdatesOn(runner));
  check('schema: the switch defaults to on', (await db.query<{ v: boolean }>('SELECT auto_migrate AS v FROM public.business_settings')).rows[0].v === true);

  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000a1', 'owner@x.co'), ('00000000-0000-0000-0000-0000000000a2', 'admin@x.co')`);
  await db.exec(`UPDATE public.team_members SET role = 'admin' WHERE email = 'admin@x.co'`);
  // Signed in as that person (their JWT claims), with row security set aside so the
  // guard itself is what is tested: in production Admins hold settings.manage.
  const attempt = async (who: string | null, sql: string): Promise<string | null> => {
    await actAs(db, who);
    await db.exec('RESET ROLE');
    try {
      const changed = (await db.query(sql + ' RETURNING 1')).rows.length;
      return changed === 1 ? null : `changed ${changed} rows`;
    } catch (error) {
      return (error as Error).message;
    } finally {
      await actAs(db, null);
      await db.exec('RESET ROLE');
    }
  };
  const ADMIN = '00000000-0000-0000-0000-0000000000a2';
  const OWNER = '00000000-0000-0000-0000-0000000000a1';
  const adminSwitch = await attempt(ADMIN, 'UPDATE public.business_settings SET auto_migrate = false');
  check('guard: an Admin cannot turn the switch off', /Only an Owner/.test(adminSwitch ?? ''), adminSwitch);
  const adminInboxes = await attempt(ADMIN, 'UPDATE public.business_settings SET owners_read_personal_inboxes = true');
  check('guard: nor change the personal inbox policy', /Only an Owner/.test(adminInboxes ?? ''), adminInboxes);
  const adminName = await attempt(ADMIN, "UPDATE public.business_settings SET business_name = 'Acme Co'");
  check('guard: an Admin still edits the rest of the business row', adminName === null, adminName);
  const ownerSwitch = await attempt(OWNER, 'UPDATE public.business_settings SET auto_migrate = false');
  check('guard: an Owner turns it off', ownerSwitch === null, ownerSwitch);
  check('runner: off means the deploy skips', !(await automaticUpdatesOn(runner)));
  const service = await attempt(null, 'UPDATE public.business_settings SET auto_migrate = true');
  check('guard: the app\'s server (service role) can change it', service === null, service);
  check('runner: back on', await automaticUpdatesOn(runner));
  await db.close();

  // An existing install: the schema before, a business row, then the migration twice.
  let before: string;
  try {
    before = schemaBeforeMigration(MIGRATION);
  } catch {
    before = schemaAt('HEAD');
  }
  const old = await createFullSchemaDatabase({ schemaSql: before });
  const oldRunner = { query: async <T>(sql: string) => (await old.query<T>(sql)).rows, exec: async (sql: string) => { await old.exec(sql); } };
  await old.exec(`UPDATE public.business_settings SET business_name = 'Kept'`);
  check('upgrade: before the migration the runner reads it as on', await automaticUpdatesOn(oldRunner));
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
  await old.exec(sql);
  await old.exec(sql);
  const kept = (await old.query<{ business_name: string; auto_migrate: boolean }>('SELECT business_name, auto_migrate FROM public.business_settings')).rows;
  check('upgrade: the existing row is kept, with the switch on', kept.length === 1 && kept[0].business_name === 'Kept' && kept[0].auto_migrate === true, kept);
  await old.close();
}

// The app's own schemas: shared with the API or not.
async function schemas() {
  const fake = (codes: Record<string, string | null>) => ({
    schema: (name: string) => ({ from: () => ({ select: () => ({ limit: async () => ({ error: codes[name] ? { code: codes[name] } : null }) }) }) }),
  }) as unknown as SupabaseClient;
  check('schemas: served, tables not there yet', await pmSchemasState(fake({ pm: 'PGRST205', pm_custom: 'PGRST205' })) === 'ready');
  check('schemas: one not shared is not_exposed', await pmSchemasState(fake({ pm: 'PGRST205', pm_custom: 'PGRST106' })) === 'not_exposed');
  check('schemas: an unexpected answer is unknown', await pmSchemasState(fake({ pm: 'XX000', pm_custom: null })) === 'unknown');
  const state = databaseUpdates({ SUPABASE_DB_URL: 'x' }, { switchOn: true, applied: null, schemas: 'not_exposed' });
  check('schemas: Settings > Updates gets the state', state.schemas === 'not_exposed');
}

async function main() {
  rules();
  await schemas();
  build();
  await route();
  await databaseChecks();
  if (failures.length) {
    console.error(`database updates: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`database updates: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
