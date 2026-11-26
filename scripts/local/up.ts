/**
 * npm run local:up: the local test stack, ready for the app.
 *
 * 1. Starts the Supabase stack in Docker (scripts/local/supabase/config.jsonc,
 *    ports 5532x).
 * 2. On an empty database, loads supabase/schema.sql the way a fresh install
 *    does, then records every core migration as applied (the runner's
 *    --baseline) and applies any custom ones, exactly as `npm run db:migrate`
 *    would after a fresh install.
 * 3. Writes scripts/local/.env.test.local (gitignored) with the stack's URL and
 *    keys, keeping the encryption key and seeded passwords it already has.
 *
 * Safe to run again: a database that already has the app is left as it is.
 * Never reads .env.local, and only ever connects to 127.0.0.1.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { baselineMigrations, listMigrationFiles, migrationDirs, migrationStatus, runMigrations, type MigrationDb } from '../lib/migrations';
import { ENV_FILE, LOCAL, assertLocal, readEnvFile, supabase } from './stack';

const APP_ROOT = join(__dirname, '..', '..');

function pgDb(client: Client): MigrationDb {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await client.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

async function main() {
  console.log('Starting the local Supabase stack (Docker)...');
  supabase(['start'], { inherit: true });
  const status = JSON.parse(supabase(['status', '-o', 'json'])) as Record<string, string>;
  const apiUrl = status.API_URL;
  const dbUrl = status.DB_URL;
  assertLocal(apiUrl, 'API_URL');
  assertLocal(dbUrl, 'DB_URL');

  const client = new Client({ connectionString: dbUrl, ssl: false });
  await client.connect();
  try {
    await client.query('SET statement_timeout = 0');
    const db = pgDb(client);
    const [{ loaded }] = await db.query<{ loaded: boolean }>(`SELECT to_regclass('pm.team_members') IS NOT NULL AS loaded`);
    if (!loaded) {
      console.log('Loading supabase/schema.sql (about 20 seconds)...');
      // psql inside the database container: the whole file, as the SQL editor runs it.
      const sql = readFileSync(join(APP_ROOT, 'supabase', 'schema.sql'));
      const result = spawnSync('docker', ['exec', '-i', LOCAL.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        console.error(result.stderr.split('\n').filter((line) => !line.includes('NOTICE')).join('\n'));
        throw new Error('schema.sql failed to load.');
      }
    } else {
      console.log('The database already has the app: leaving it as it is.');
    }

    const files = listMigrationFiles(migrationDirs(APP_ROOT));
    const tracked = await migrationStatus(db, files);
    if (tracked.empty) {
      await baselineMigrations(db, files, { log: (line) => console.log(line) });
    }
    const result = await runMigrations(db, files, { log: (line) => console.log(line) });
    if (result.applied.length) console.log(`Applied ${result.applied.length} migration(s).`);
    const after = await migrationStatus(db, files);
    console.log(`Migrations: ${after.applied.length} recorded, ${after.pending.length} pending.`);
    // PostgREST picks up the new tables now rather than on its next poll.
    await client.query(`NOTIFY pgrst, 'reload schema'`);
  } finally {
    await client.end().catch(() => {});
  }

  // The env file: stack values refreshed, generated secrets kept.
  const previous = existsSync(ENV_FILE) ? readEnvFile() : {};
  const keep = (key: string, make: () => string) => previous[key] || make();
  const values: Record<string, string> = {
    NEXT_PUBLIC_APP_URL: `http://localhost:${LOCAL.appPort}`,
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    APP_ENCRYPTION_KEY: keep('APP_ENCRYPTION_KEY', () => randomBytes(32).toString('hex')),
    SUPABASE_DB_URL: dbUrl,
    DATABASE_URL: dbUrl,
    CRON_SECRET: keep('CRON_SECRET', () => randomBytes(32).toString('hex')),
    NEXT_PUBLIC_DEMO_MODE: 'false',
    DEMO_MODE: 'false',
  };
  const seeded = Object.entries(previous).filter(([key]) => key.startsWith('LOCAL_'));
  const lines = [
    '# Local test stack for the PM app. Written by npm run local:up and local:seed.',
    '# Gitignored. Points only at the Docker stack on this machine (never production).',
    '# The dev server (npm run local:dev) reads this file and no other .env file.',
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '',
    '# Seeded logins (npm run local:seed). Not passed to the dev server.',
    ...seeded.map(([key, value]) => `${key}=${value}`),
    '',
  ];
  writeFileSync(ENV_FILE, lines.join('\n'));
  console.log(`
Ready.
  API     ${apiUrl}
  Studio  ${status.STUDIO_URL}
  Email   ${status.MAILPIT_URL ?? status.INBUCKET_URL ?? ''} (every email the stack sends lands here)
  Env     scripts/local/.env.test.local
Next: npm run local:seed, then npm run local:dev (http://localhost:${LOCAL.appPort}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
