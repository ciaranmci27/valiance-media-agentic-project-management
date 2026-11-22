/**
 * The migration runner: pending files apply in name order, core before
 * custom, each recorded with its checksum; applied files are skipped; a file
 * edited after it ran is reported and never re-run; a failing file stops the
 * run and is not recorded; a baseline records without running; and the
 * connection settings come from the right variable, safely.
 *
 * Runs on PGlite with migration files in a temp folder. Nothing touches a
 * live database.
 *
 *   npm run -s test:db-migrate
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  MigrationError,
  baselineMigrations,
  checksumOf,
  listMigrationFiles,
  migrationStatus,
  resolveConnection,
  runMigrations,
  trackingTable,
  type MigrationDb,
  type MigrationDirs,
} from './lib/migrations';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function rejects(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function pgliteDb(db: PGlite): MigrationDb {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await db.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

/** An empty database with the API roles every Supabase project has (the tracking table revokes from them). */
async function supabaseDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  return db;
}

const root = mkdtempSync(join(tmpdir(), 'vm-db-migrate-'));
const dirs: MigrationDirs = { coreDir: join(root, 'migrations'), customDir: join(root, 'migrations', 'custom') };
mkdirSync(dirs.customDir, { recursive: true });
const core = (name: string, sql: string) => writeFileSync(join(dirs.coreDir, name), sql);
const custom = (name: string, sql: string) => writeFileSync(join(dirs.customDir, name), sql);

async function tableExists(db: PGlite, name: string) {
  const { rows } = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
  return rows[0].present;
}

async function recorded(db: PGlite) {
  const { rows } = await db.query<{ name: string; kind: string; checksum: string }>('SELECT name, kind, checksum FROM public.app_migrations ORDER BY applied_at, name');
  return rows;
}

async function main() {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  // 0. Whose database is it? The runner makes its table only where the app lives.
  const bare = await supabaseDb();
  const bareRun = await rejects(() => baselineMigrations(pgliteDb(bare), listMigrationFiles(dirs), { log }));
  check('a database without the app is refused (nothing is made)', bareRun instanceof Error && /does not hold the PM app/.test(bareRun.message) && !(await tableExists(bare, 'public.app_migrations')), String(bareRun));
  await bare.exec(`CREATE TABLE public.workspace_modules (module_id text); CREATE TABLE public.business_settings (id int);
    CREATE TABLE public.app_migrations (id serial, version text, ran_at timestamptz)`);
  const theirs = await rejects(() => runMigrations(pgliteDb(bare), listMigrationFiles(dirs), { log }));
  check('another app\'s public.app_migrations is never read or written', theirs instanceof Error && /belongs to another app/.test(theirs.message), String(theirs));
  check('and it is left as it was', (await bare.query('SELECT 1 FROM public.app_migrations')).rows.length === 0);
  check('status reads nothing from it either', (await migrationStatus(pgliteDb(bare), listMigrationFiles(dirs))).applied.length === 0);
  await bare.close();

  const moved = await supabaseDb();
  await moved.exec('CREATE SCHEMA pm; CREATE TABLE pm.workspace_modules (module_id text); CREATE TABLE pm.business_settings (id int);');
  const movedTable = await trackingTable(pgliteDb(moved));
  check('with the app in pm, the table goes in pm', movedTable?.table === 'pm.app_migrations' && movedTable.exists === false, movedTable);
  await moved.exec(`CREATE SCHEMA cron; CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, touched int NOT NULL DEFAULT 0);
    INSERT INTO cron.job VALUES (1, 'pm-webhook-retries', '* * * * *', 0);
    CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL) RETURNS void LANGUAGE sql
      AS $$ UPDATE cron.job SET touched = touched + 1 WHERE jobid = job_id $$;`);
  await baselineMigrations(pgliteDb(moved), listMigrationFiles(dirs), { log });
  check('and the baseline lands there, nothing in public', await tableExists(moved, 'pm.app_migrations') && !(await tableExists(moved, 'public.app_migrations')));
  check('a baseline refreshes the scheduled jobs too (a database just built from schema.sql)', Number((await moved.query<{ touched: number }>('SELECT touched FROM cron.job')).rows[0].touched) === 1);
  await moved.close();

  // A shared database: another app owns public.app_migrations, the PM app lives in pm.
  const shared = await supabaseDb();
  await shared.exec('CREATE TABLE public.app_migrations (id serial, version text); INSERT INTO public.app_migrations (version) VALUES ("v9"); CREATE SCHEMA pm; CREATE TABLE pm.workspace_modules (module_id text); CREATE TABLE pm.business_settings (id int);'.replace(/"/g, "'"));
  await baselineMigrations(pgliteDb(shared), listMigrationFiles(dirs), { log });
  check('a shared database: the baseline lands in pm, the other app\x27s table untouched', await tableExists(shared, 'pm.app_migrations')
    && (await shared.query('SELECT count(*)::int AS n FROM public.app_migrations')).rows[0] !== undefined
    && Number(((await shared.query<{ n: number }>('SELECT count(*)::int AS n FROM public.app_migrations')).rows[0]).n) === 1);
  await shared.close();

  // A look-alike: the other app's public.app_migrations has the runner's very columns.
  const lookalike = await supabaseDb();
  await lookalike.exec(`CREATE TABLE public.app_migrations (name text PRIMARY KEY, kind text, checksum text); INSERT INTO public.app_migrations VALUES ('theirs.sql', 'core', 'x');
    CREATE SCHEMA pm; CREATE TABLE pm.workspace_modules (module_id text); CREATE TABLE pm.business_settings (id int);`);
  const lookalikeTable = await trackingTable(pgliteDb(lookalike));
  check('a look-alike public.app_migrations beside the app in pm: the table goes in pm', lookalikeTable?.table === 'pm.app_migrations', lookalikeTable);
  await baselineMigrations(pgliteDb(lookalike), listMigrationFiles(dirs), { log });
  check('and the baseline writes nothing into theirs', Number((await lookalike.query<{ n: number }>('SELECT count(*)::int AS n FROM public.app_migrations')).rows[0].n) === 1);
  await lookalike.close();

  const pg = await supabaseDb();
  // The app's own tables, so this reads as the app's database.
  await pg.exec('CREATE TABLE public.workspace_modules (module_id text); CREATE TABLE public.business_settings (id int);');
  const db = pgliteDb(pg);

  // The files schema.sql already holds: a baseline must record them without running them.
  core('20260101000000_base.sql', 'CREATE TABLE public.baseline_must_not_run (id int);');
  core('20260102_older_style.sql', 'CREATE TABLE public.baseline_must_not_run_either (id int);');

  // 1. No history: refuse to run anything.
  const noHistory = await rejects(() => runMigrations(db, listMigrationFiles(dirs), { log }));
  check('a database with no history refuses to run', noHistory instanceof Error && /--baseline/.test(noHistory.message), String(noHistory));
  check('nothing ran without history', !(await tableExists(pg, 'public.baseline_must_not_run')));

  // 2. Baseline records every core file, runs none, and skips custom files.
  custom('00000000_early_name.sql', 'CREATE SCHEMA IF NOT EXISTS custom; CREATE TABLE custom.notes (id int, task int REFERENCES public.tasks(id));');
  const baselined = await baselineMigrations(db, listMigrationFiles(dirs), { log });
  check('baseline records the core files', JSON.stringify(baselined) === JSON.stringify(['20260101000000_base.sql', '20260102_older_style.sql']), baselined);
  check('baseline runs nothing', !(await tableExists(pg, 'public.baseline_must_not_run')) && !(await tableExists(pg, 'public.baseline_must_not_run_either')));
  const afterBaseline = await recorded(pg);
  check('baseline records checksums', afterBaseline.every(row => row.kind === 'core' && /^[0-9a-f]{64}$/.test(row.checksum)), afterBaseline);
  check('baseline does not record custom files', !afterBaseline.some(row => row.name.startsWith('custom/')), afterBaseline);

  // 3. A second baseline is refused unless forced.
  const again = await rejects(() => baselineMigrations(db, listMigrationFiles(dirs), { log }));
  check('a second baseline is refused', again instanceof Error && /already has 2 rows/.test(again.message), String(again));
  const forced = await baselineMigrations(db, listMigrationFiles(dirs), { force: true, log });
  check('--force-baseline upserts', forced.length === 2 && (await recorded(pg)).length === 2);

  // 4. Pending files run in name order, core first, then custom, each recorded.
  core('20260301000000_create_tasks.sql', 'CREATE TABLE public.tasks (id int PRIMARY KEY); CREATE TABLE public.run_log (n serial, name text); INSERT INTO public.run_log (name) VALUES (\'create_tasks\');');
  core('20260302000000_alter_tasks.sql', 'ALTER TABLE public.tasks ADD COLUMN title text; INSERT INTO public.run_log (name) VALUES (\'alter_tasks\');');
  const status = await migrationStatus(db, listMigrationFiles(dirs));
  check('status lists pending in run order',
    JSON.stringify(status.pending.map(f => f.name)) === JSON.stringify(['20260301000000_create_tasks.sql', '20260302000000_alter_tasks.sql', 'custom/00000000_early_name.sql']),
    status.pending.map(f => f.name));

  const dry = await runMigrations(db, listMigrationFiles(dirs), { dryRun: true, log });
  check('dry run lists the pending files', dry.pending.length === 3 && dry.applied.length === 0, dry);
  check('dry run applies nothing', !(await tableExists(pg, 'public.tasks')));

  const coreOnly = await runMigrations(db, listMigrationFiles(dirs, { coreOnly: true }), { log });
  check('--core-only applies core files only', JSON.stringify(coreOnly.applied) === JSON.stringify(['20260301000000_create_tasks.sql', '20260302000000_alter_tasks.sql']), coreOnly);
  check('--core-only leaves custom pending', !(await tableExists(pg, 'custom.notes')));

  const run = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('custom files run after core (even when their names sort first)', JSON.stringify(run.applied) === JSON.stringify(['custom/00000000_early_name.sql']), run);
  check('the custom table exists, pointing at the core table', await tableExists(pg, 'custom.notes'));
  const rows = await recorded(pg);
  const customRow = rows.find(row => row.name === 'custom/00000000_early_name.sql');
  check('custom files are recorded as kind custom', customRow?.kind === 'custom', rows);
  const files = listMigrationFiles(dirs);
  check('recorded checksums match the files', files.every(file => rows.find(row => row.name === file.name)?.checksum === file.checksum), rows);
  const { rows: order } = await pg.query<{ name: string }>('SELECT name FROM public.run_log ORDER BY n');
  check('core files ran in name order', JSON.stringify(order.map(r => r.name)) === JSON.stringify(['create_tasks', 'alter_tasks']), order);

  // 5. Applied files are skipped.
  const second = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('a second run applies nothing', second.applied.length === 0 && second.pending.length === 0, second);

  // 5b. Every run touches the app's scheduled jobs on their own, so pg_cron
  // reloads them after a big migration (it misses changes made inside one).
  logs.length = 0;
  const noCron = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('without pg_cron, the refresh is skipped quietly', noCron.applied.length === 0 && !logs.some(l => /scheduled jobs/.test(l)), logs);
  await pg.exec(`CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, touched int NOT NULL DEFAULT 0);
    INSERT INTO cron.job (jobid, jobname, schedule) VALUES (1, 'pm-reminders-due', '*/5 * * * *'), (2, 'their-nightly-job', '0 3 * * *');
    CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL) RETURNS void LANGUAGE sql
      AS $$ UPDATE cron.job SET touched = touched + 1, schedule = coalesce(alter_job.schedule, cron.job.schedule) WHERE jobid = job_id $$;`);
  await runMigrations(db, listMigrationFiles(dirs), { log });
  const { rows: jobs } = await pg.query<{ jobname: string; schedule: string; touched: number }>('SELECT jobname, schedule, touched FROM cron.job ORDER BY jobid');
  check('a run touches the app jobs, keeping their schedules', jobs[0].touched === 1 && jobs[0].schedule === '*/5 * * * *', jobs);
  check('and never another app job', jobs[1].touched === 0, jobs);
  await pg.exec('DROP FUNCTION cron.alter_job(bigint, text)');
  logs.length = 0;
  const broken = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('a refresh that fails never fails the run, and says so', broken.applied.length === 0 && logs.some(l => /could not refresh the scheduled jobs/.test(l)), logs);
  await pg.exec('DROP SCHEMA cron CASCADE');

  // 6. A changed file is reported, never re-run.
  core('20260301000000_create_tasks.sql', 'CREATE TABLE public.tasks (id int PRIMARY KEY); CREATE TABLE public.run_log (n serial, name text); INSERT INTO public.run_log (name) VALUES (\'create_tasks\'); -- edited');
  logs.length = 0;
  const changed = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('a changed file is reported', JSON.stringify(changed.changed) === JSON.stringify(['20260301000000_create_tasks.sql']), changed);
  check('the change is a warning in the log', logs.some(line => line.startsWith('WARNING: 20260301000000_create_tasks.sql changed')), logs);
  check('a changed file does not run again', changed.applied.length === 0 && (await pg.query('SELECT 1 FROM public.run_log')).rows.length === 2);
  const changedStatus = await migrationStatus(db, listMigrationFiles(dirs));
  check('status lists the changed file', changedStatus.changed.map(f => f.name).join() === '20260301000000_create_tasks.sql', changedStatus.changed.map(f => f.name));

  // 7. Checksums ignore CRLF line endings.
  check('CRLF and LF checksums match', checksumOf('SELECT 1;\r\nSELECT 2;\r\n') === checksumOf('SELECT 1;\nSELECT 2;\n'));
  check('different contents differ', checksumOf('SELECT 1;') !== checksumOf('SELECT 2;'));

  // 8. A failing file stops the run, is rolled back and not recorded; later files do not run.
  core('20260401000000_breaks.sql', 'CREATE TABLE public.half_done (id int); SELECT 1 / 0;');
  core('20260402000000_after.sql', 'CREATE TABLE public.after_failure (id int);');
  custom('00000001_custom_after.sql', 'CREATE TABLE custom.after_failure (id int);');
  const failure = await rejects(() => runMigrations(db, listMigrationFiles(dirs), { log }));
  check('the failure names the file', failure instanceof MigrationError && failure.file === '20260401000000_breaks.sql', String(failure));
  check('the failure carries the database error', failure instanceof MigrationError && /division by zero/.test(failure.message), String(failure));
  check('the failed file is rolled back', !(await tableExists(pg, 'public.half_done')));
  check('the failed file is not recorded', !(await recorded(pg)).some(row => row.name === '20260401000000_breaks.sql'));
  check('nothing after the failure runs', !(await tableExists(pg, 'public.after_failure')) && !(await tableExists(pg, 'custom.after_failure')));
  check('the session is usable after a failure', (await pg.query('SELECT 1 AS one')).rows.length === 1);
  const { rows: locks } = await pg.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'`);
  check('the advisory lock is released after a failure', locks.length === 0, locks);

  // 9. Once fixed (as the file it is: never recorded, so it may still change), the rest follows.
  core('20260401000000_breaks.sql', 'CREATE TABLE public.half_done (id int);');
  const fixed = await runMigrations(db, listMigrationFiles(dirs), { log });
  check('the fixed file and everything after it apply in order',
    JSON.stringify(fixed.applied) === JSON.stringify(['20260401000000_breaks.sql', '20260402000000_after.sql', 'custom/00000001_custom_after.sql']), fixed);

  await pg.close();

  // 10. Connection settings.
  // The 2.0 move: a file that moves the app, tracking table included, into pm
  // is recorded in pm, in the same transaction.
  const mover = await supabaseDb();
  await mover.exec('CREATE TABLE public.workspace_modules (module_id text); CREATE TABLE public.business_settings (id int);');
  await baselineMigrations(pgliteDb(mover), listMigrationFiles(dirs), { log });
  core('20991231000000_move_to_pm.sql', 'CREATE SCHEMA pm; ALTER TABLE public.app_migrations SET SCHEMA pm; ALTER TABLE public.workspace_modules SET SCHEMA pm; ALTER TABLE public.business_settings SET SCHEMA pm;');
  const moveRun = await runMigrations(pgliteDb(mover), listMigrationFiles(dirs, { coreOnly: true }), { log });
  const inPm = (await mover.query<{ name: string }>("SELECT name FROM pm.app_migrations WHERE name = '20991231000000_move_to_pm.sql'")).rows;
  check('the move is recorded in pm, where the table now is', moveRun.applied.includes('20991231000000_move_to_pm.sql') && inPm.length === 1 && !(await tableExists(mover, 'public.app_migrations')), { applied: moveRun.applied, inPm });
  const afterMove = await migrationStatus(pgliteDb(mover), listMigrationFiles(dirs, { coreOnly: true }));
  check('and later runs read pm: nothing is pending', afterMove.pending.length === 0 && afterMove.applied.length > 0, afterMove.pending.map((p) => p.name));
  await mover.close();

  const envFiles = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, text]) => ({ name, text }));
  const fromEnv = resolveConnection({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/postgres?sslmode=require' }, envFiles({ '.env.local': 'DATABASE_URL=postgres://other' }));
  check('the environment wins over env files', fromEnv.source === 'DATABASE_URL from the environment', fromEnv.source);
  check('sslmode is stripped', !fromEnv.connectionString.includes('sslmode'), fromEnv.connectionString);
  check('remote hosts use TLS without pinning', fromEnv.ssl !== false && fromEnv.ssl.rejectUnauthorized === false);
  const local = resolveConnection({}, envFiles({ '.env.local': 'SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"' }));
  check('SUPABASE_DB_URL from .env.local is used', local.source === 'SUPABASE_DB_URL from .env.local', local.source);
  check('local hosts connect without TLS', local.ssl === false);
  const order2 = resolveConnection({}, envFiles({ '.env.local': 'SUPABASE_DB_URL=postgres://a@h1:5432/x', '.env': 'DATABASE_URL=postgres://a@h2:5432/x' }));
  check('DATABASE_URL anywhere beats SUPABASE_DB_URL', order2.source === 'DATABASE_URL from .env', order2.source);
  const pooler = (() => { try { resolveConnection({ DATABASE_URL: 'postgres://u:p@pooler.supabase.com:6543/postgres' }, []); return null; } catch (err) { return err as Error; } })();
  check('the transaction pooler is refused', pooler !== null && /5432/.test(pooler.message), String(pooler));
  const none = (() => { try { resolveConnection({}, []); return null; } catch (err) { return err as Error; } })();
  check('no URL is a clear error', none !== null && /DATABASE_URL/.test(none.message), String(none));
}

main()
  .catch(err => failures.push(`crashed: ${err instanceof Error ? err.stack : String(err)}`))
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    if (failures.length) {
      console.error(`db-migrate: ${failures.length} failed, ${passed} passed`);
      for (const failure of failures) console.error(`  FAIL ${failure}`);
      process.exit(1);
    }
    console.log(`db-migrate: all ${passed} checks passed`);
  });
