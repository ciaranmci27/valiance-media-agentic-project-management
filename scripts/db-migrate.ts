/**
 * Apply pending database migrations: core files first, then this install's
 * own files in supabase/migrations/custom, each in its own transaction.
 *
 *   npm run db:migrate                     apply everything pending
 *   npm run db:migrate -- --status         list applied, pending and changed files
 *   npm run db:migrate -- --dry-run        show what would run, run nothing
 *   npm run db:migrate -- --core-only      skip supabase/migrations/custom
 *   npm run db:migrate -- --baseline       record every core file as applied without running it
 *   npm run db:migrate -- --baseline --force-baseline   the same on an already tracked database
 *
 * --baseline is the first run on any database: one built from schema.sql, or
 * an existing install adopting the runner. Connection: DATABASE_URL, else
 * SUPABASE_DB_URL, from the environment, .env.local or .env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  MigrationError,
  baselineMigrations,
  listMigrationFiles,
  migrationDirs,
  migrationStatus,
  resolveConnection,
  runMigrations,
  type MigrationDb,
} from './lib/migrations';

const APP_ROOT = join(__dirname, '..');

export interface CliOptions {
  status: boolean;
  dryRun: boolean;
  baseline: boolean;
  forceBaseline: boolean;
  coreOnly: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const known = new Set(['--status', '--dry-run', '--baseline', '--force-baseline', '--core-only']);
  const unknown = argv.filter(arg => !known.has(arg));
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}. Options: ${[...known].join(' ')}`);
  return {
    status: argv.includes('--status'),
    dryRun: argv.includes('--dry-run'),
    baseline: argv.includes('--baseline') || argv.includes('--force-baseline'),
    forceBaseline: argv.includes('--force-baseline'),
    coreOnly: argv.includes('--core-only'),
  };
}

function envFiles(root: string) {
  return ['.env.local', '.env']
    .map(name => join(root, name))
    .filter(path => existsSync(path))
    .map(path => ({ name: path.endsWith('.local') ? '.env.local' : '.env', text: readFileSync(path, 'utf8') }));
}

function pgDb(client: Client): MigrationDb {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await client.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      // No parameters: the simple query protocol runs a whole multi-statement file.
      await client.query(sql);
    },
  };
}

/** Runs the command; returns the process exit code. */
export async function main(argv: string[], root = APP_ROOT): Promise<number> {
  const options = parseArgs(argv);
  const files = listMigrationFiles(migrationDirs(root), { coreOnly: options.coreOnly });
  const connection = resolveConnection(process.env, envFiles(root));
  const client = new Client({ connectionString: connection.connectionString, ssl: connection.ssl, connectionTimeoutMillis: 15_000 });
  const log = (line: string) => console.log(line);
  console.log(`Connecting with ${connection.source}.`);
  await client.connect();
  try {
    // Migrations can outlast a role's default statement timeout.
    await client.query('SET statement_timeout = 0');
    const db = pgDb(client);

    if (options.status) {
      const status = await migrationStatus(db, files);
      console.log(`Applied: ${status.applied.length}`);
      console.log(`Pending: ${status.pending.length}${status.pending.length ? '' : ' (up to date)'}`);
      for (const file of status.pending) console.log(`  pending  ${file.name}`);
      for (const file of status.changed) console.log(`  changed  ${file.name} (edited after it was applied; it will not run again)`);
      for (const row of status.missing) console.log(`  no file  ${row.name} (recorded ${row.applied_at})`);
      if (status.empty) console.log('No migration history yet: run npm run db:migrate -- --baseline first.');
      return 0;
    }

    if (options.baseline) {
      await baselineMigrations(db, files, { force: options.forceBaseline, log });
      const custom = files.filter(file => file.kind === 'custom').length;
      if (custom) console.log(`${custom} custom migration file(s) were not recorded: npm run db:migrate applies them.`);
      return 0;
    }

    const result = await runMigrations(db, files, { dryRun: options.dryRun, log });
    if (!options.dryRun && result.applied.length) console.log(`Applied ${result.applied.length} migration(s).`);
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Prints a failure the way an operator needs it: which file stopped the run and why. */
export function reportError(err: unknown) {
  if (err instanceof MigrationError) {
    console.error(`
Stopped at ${err.file}. Nothing after it ran, and it was rolled back.`);
    const cause = err.cause as { message?: string; detail?: string; hint?: string } | undefined;
    console.error(`Error: ${cause?.message ?? String(err.cause)}`);
    if (cause?.detail) console.error(`Detail: ${cause.detail}`);
    if (cause?.hint) console.error(`Hint: ${cause.hint}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      reportError(err);
      process.exit(1);
    },
  );
}
