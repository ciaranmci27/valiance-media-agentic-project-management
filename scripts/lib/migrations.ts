/**
 * The migration runner behind `npm run db:migrate`.
 *
 * Core migrations (supabase/migrations/*.sql) run first, then the install's
 * own (supabase/migrations/custom/*.sql), each set in file name order. Every
 * file runs in its own transaction together with its row in
 * public.app_migrations, so a file is either fully applied and recorded or not
 * at all. One advisory lock covers the whole run, so two deploys can never
 * apply the same file at once.
 *
 * A recorded file whose contents changed is reported and never re-run:
 * migrations are append-only, a fix ships as a new file.
 *
 * The database sits behind a two-method interface so tests run the same code
 * on PGlite; scripts/db-migrate.ts plugs in node-postgres.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MigrationKind = 'core' | 'custom';

/** The only database access the runner needs. One session: the lock and transactions depend on it. */
export interface MigrationDb {
  /** One parameterised statement; returns its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** A whole script of statements (a migration file), no parameters. */
  exec(sql: string): Promise<void>;
}

export interface MigrationFile {
  /** Tracking key: the file name for core, `custom/<file name>` for custom, so the two sets never collide. */
  name: string;
  kind: MigrationKind;
  path: string;
  sql: string;
  checksum: string;
}

export interface AppliedRow {
  name: string;
  kind: MigrationKind;
  checksum: string;
  applied_at: string;
}

export interface MigrationStatus {
  applied: MigrationFile[];
  pending: MigrationFile[];
  /** Recorded files whose contents no longer match the recorded checksum. */
  changed: MigrationFile[];
  /** Recorded names with no file on disk (informational: a removed or renamed file). */
  missing: AppliedRow[];
  /** True when app_migrations has no rows yet (or does not exist). */
  empty: boolean;
}

export type Log = (line: string) => void;

export class MigrationError extends Error {
  constructor(public file: string, public cause: unknown) {
    super(`${file} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
  }
}

/** Fixed key for pg_advisory_lock: every migration run on any install takes this one. */
export const MIGRATION_LOCK_KEY = 7_262_011_301;

/**
 * The runner's own bookkeeping table. It lives with the app's tables: in
 * `public` until 2.0 moves the app into `pm`, then in `pm`. In a database
 * the app shares with other apps, `public` belongs to someone else, so the
 * runner never creates or trusts a table there unless it is provably the
 * app's (see trackingTable).
 */
export function trackingTableSql(schema: 'public' | 'pm'): string {
  return TRACKING_TABLE_SQL.split('public.app_migrations').join(`${schema}.app_migrations`);
}

export const TRACKING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.app_migrations (
  name text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('core', 'custom')),
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
-- Bookkeeping for the migration runner only: no API role reads or writes it.
ALTER TABLE public.app_migrations ENABLE ROW LEVEL SECURITY;
`;

/** sha256 of the file with CRLF normalized, so a Windows checkout records the same checksum as Linux. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Plain code-unit order: deterministic on every machine, unlike localeCompare. */
export function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readDir(dir: string, kind: MigrationKind): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort(byName)
    .map(file => {
      const path = join(dir, file);
      const sql = readFileSync(path, 'utf8');
      return { name: kind === 'core' ? file : `custom/${file}`, kind, path, sql, checksum: checksumOf(sql) };
    });
}

export interface MigrationDirs {
  /** supabase/migrations */
  coreDir: string;
  /** supabase/migrations/custom */
  customDir: string;
}

export function migrationDirs(appRoot: string): MigrationDirs {
  const coreDir = join(appRoot, 'supabase', 'migrations');
  return { coreDir, customDir: join(coreDir, 'custom') };
}

/** Every migration in run order: all core files, then all custom files. */
export function listMigrationFiles(dirs: MigrationDirs, options: { coreOnly?: boolean } = {}): MigrationFile[] {
  const core = readDir(dirs.coreDir, 'core');
  return options.coreOnly ? core : [...core, ...readDir(dirs.customDir, 'custom')];
}

/**
 * Where the tracking table is, or should be:
 * - `pm.app_migrations` once it exists (2.0 and later);
 * - else `public.app_migrations`, but only when it is the app's: it has the
 *   runner's columns (name, kind, checksum), or, not made yet, `public`
 *   holds the app's own tables (workspace_modules and business_settings);
 * - else, when the app's tables are in `pm`, `pm.app_migrations` (to make).
 * Null means this database does not hold the app yet (or `public`'s table of
 * that name is someone else's): the runner refuses rather than guess.
 */
export async function trackingTable(db: MigrationDb): Promise<{ table: string; exists: boolean } | null> {
  const [row] = await db.query<{ pm_table: boolean; public_table: boolean; public_ours: boolean; public_app: boolean; pm_app: boolean }>(`
    SELECT to_regclass('pm.app_migrations') IS NOT NULL AS pm_table,
           to_regclass('public.app_migrations') IS NOT NULL AS public_table,
           (SELECT count(*) = 3 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'app_migrations' AND column_name IN ('name', 'kind', 'checksum')) AS public_ours,
           to_regclass('public.workspace_modules') IS NOT NULL AND to_regclass('public.business_settings') IS NOT NULL AS public_app,
           to_regclass('pm.workspace_modules') IS NOT NULL AND to_regclass('pm.business_settings') IS NOT NULL AS pm_app`);
  if (row?.pm_table) return { table: 'pm.app_migrations', exists: true };
  // Another app's public.app_migrations is never ours; the app may still live in pm.
  if (row?.public_table && row.public_ours) return { table: 'public.app_migrations', exists: true };
  if (row?.public_app && !row.public_table) return { table: 'public.app_migrations', exists: false };
  if (row?.pm_app) return { table: 'pm.app_migrations', exists: false };
  return null;
}

const NOT_THE_APP = 'This database does not hold the PM app\'s tables (or its public.app_migrations belongs to another app), so the runner will not create or read its tracking table here. Run supabase/schema.sql first.';

/** Makes the tracking table where trackingTable says, and answers its name. */
async function ensureTrackingTable(db: MigrationDb): Promise<string> {
  const where = await trackingTable(db);
  if (!where) throw new Error(NOT_THE_APP);
  if (!where.exists) await db.exec(trackingTableSql(where.table.startsWith('pm.') ? 'pm' : 'public'));
  return where.table;
}

async function appliedRows(db: MigrationDb): Promise<AppliedRow[]> {
  const where = await trackingTable(db);
  if (!where?.exists) return [];
  return db.query<AppliedRow>(`SELECT name, kind, checksum, applied_at::text AS applied_at FROM ${where.table} ORDER BY name`);
}

/** Read-only: never creates the tracking table. */
export async function migrationStatus(db: MigrationDb, files: MigrationFile[]): Promise<MigrationStatus> {
  const rows = await appliedRows(db);
  const recorded = new Map(rows.map(row => [row.name, row]));
  const onDisk = new Set(files.map(file => file.name));
  const status: MigrationStatus = { applied: [], pending: [], changed: [], missing: [], empty: rows.length === 0 };
  for (const file of files) {
    const row = recorded.get(file.name);
    if (!row) status.pending.push(file);
    else {
      status.applied.push(file);
      if (row.checksum !== file.checksum) status.changed.push(file);
    }
  }
  status.missing = rows.filter(row => !onDisk.has(row.name));
  return status;
}

async function withLock<T>(db: MigrationDb, log: Log, fn: () => Promise<T>): Promise<T> {
  const [got] = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_KEY]);
  if (!got?.locked) {
    log('Another migration run holds the lock; waiting for it to finish...');
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  }
  try {
    return await fn();
  } finally {
    // A lost connection already dropped the lock; keep the original error.
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

export interface RunOptions {
  dryRun?: boolean;
  log?: Log;
}

export interface RunResult {
  applied: string[];
  /** What would run (dry run) or what was pending at the start. */
  pending: string[];
  changed: string[];
}

const NO_HISTORY = [
  'This database has no migration history yet, so nothing was run.',
  'Record the current core migrations first: npm run db:migrate -- --baseline',
  '(a fresh database loads supabase/schema.sql before the baseline).',
].join('\n');

/**
 * Applies every pending file in order, each in its own transaction with its
 * tracking row. Stops at the first failure and throws a MigrationError naming
 * the file; earlier files stay applied, the failed one is rolled back.
 *
 * Refuses to run against a database with no recorded history: running every
 * core file over an existing install, or over an empty database that schema.sql
 * never built, is never what anyone wants. --baseline is the first step.
 */
export async function runMigrations(db: MigrationDb, files: MigrationFile[], options: RunOptions = {}): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const report = (status: MigrationStatus) => {
    for (const file of status.changed) {
      log(`WARNING: ${file.name} changed after it was applied. It will not run again; ship the fix as a new migration.`);
    }
    return { pending: status.pending.map(f => f.name), changed: status.changed.map(f => f.name) };
  };

  if (options.dryRun) {
    const status = await migrationStatus(db, files);
    if (status.empty) throw new Error(NO_HISTORY);
    const { pending, changed } = report(status);
    for (const name of pending) log(`would apply ${name}`);
    if (!pending.length) log('Nothing to apply.');
    return { applied: [], pending, changed };
  }

  await ensureTrackingTable(db);
  return withLock(db, log, async () => {
    // Read the status under the lock: a run that waited sees what the other one applied.
    const status = await migrationStatus(db, files);
    if (status.empty) throw new Error(NO_HISTORY);
    const { pending, changed } = report(status);
    const applied: string[] = [];
    for (const file of status.pending) {
      log(`applying ${file.name}`);
      await db.exec('BEGIN');
      try {
        await db.exec(file.sql);
        // Found again after each file: the one that moves the app into pm moves this table too.
        const table = (await trackingTable(db))?.table;
        if (!table) throw new Error(NOT_THE_APP);
        await db.query(
          `INSERT INTO ${table} (name, kind, checksum) VALUES ($1, $2, $3)`,
          [file.name, file.kind, file.checksum],
        );
        await db.exec('COMMIT');
      } catch (err) {
        await db.exec('ROLLBACK').catch(() => {});
        throw new MigrationError(file.name, err);
      }
      applied.push(file.name);
    }
    if (!applied.length) log('Nothing to apply.');
    return { applied, pending, changed };
  });
}

export interface BaselineOptions {
  /** Record even when app_migrations already has rows (upserts every core file's current checksum). */
  force?: boolean;
  log?: Log;
}

/**
 * Records every given core file as applied without running it: for a database
 * built from schema.sql (which already holds every core migration), or an
 * existing install adopting the runner. Custom files are never baselined.
 */
export async function baselineMigrations(db: MigrationDb, files: MigrationFile[], options: BaselineOptions = {}): Promise<string[]> {
  const log = options.log ?? (() => {});
  const core = files.filter(file => file.kind === 'core');
  const table = await ensureTrackingTable(db);
  return withLock(db, log, async () => {
    const [{ count }] = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    if (count > 0 && !options.force) {
      throw new Error(
        `app_migrations already has ${count} rows, so this database is already tracked. ` +
        'Use --force-baseline only if you are sure every core file on disk is in this database.',
      );
    }
    await db.exec('BEGIN');
    try {
      for (const file of core) {
        await db.query(
          `INSERT INTO ${table} (name, kind, checksum) VALUES ($1, 'core', $2)
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum`,
          [file.name, file.checksum],
        );
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK').catch(() => {});
      throw err;
    }
    log(`Recorded ${core.length} core migrations as applied (none were run).`);
    return core.map(file => file.name);
  });
}

/* ------------------------------------------------------------------ */
/* Connection settings                                                 */
/* ------------------------------------------------------------------ */

export interface ConnectionSettings {
  connectionString: string;
  ssl: false | { rejectUnauthorized: false };
  /** Which variable it came from and where, for the log line (never the value). */
  source: string;
}

/** KEY=value lines; quotes stripped. Enough for the two variables the runner reads. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * DATABASE_URL, else SUPABASE_DB_URL: from the environment first, then
 * .env.local, then .env. sslmode is stripped (node-postgres would let it
 * override the ssl option) and non-local hosts connect over TLS without
 * certificate pinning, as Supabase requires.
 */
export function resolveConnection(env: Record<string, string | undefined>, envFiles: { name: string; text: string }[]): ConnectionSettings {
  const sources: { name: string; values: Record<string, string | undefined> }[] = [
    { name: 'the environment', values: env },
    ...envFiles.map(file => ({ name: file.name, values: parseEnvFile(file.text) })),
  ];
  for (const variable of ['DATABASE_URL', 'SUPABASE_DB_URL']) {
    for (const source of sources) {
      const raw = source.values[variable]?.trim();
      if (!raw) continue;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`${variable} from ${source.name} is not a valid postgres:// URL.`);
      }
      // Supavisor's transaction pooler (6543) hands each statement to any backend:
      // a session advisory lock taken there can outlive this run and block the next.
      if (url.port === '6543') {
        throw new Error(
          `${variable} from ${source.name} uses the transaction pooler (port 6543), which cannot hold the migration lock. ` +
          'Use the session pooler (same host, port 5432) or the direct database URL.',
        );
      }
      url.searchParams.delete('sslmode');
      const local = LOCAL_HOSTS.has(url.hostname);
      return { connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false }, source: `${variable} from ${source.name}` };
    }
  }
  throw new Error('No database URL: set DATABASE_URL (or SUPABASE_DB_URL) in the environment, .env.local or .env.');
}
