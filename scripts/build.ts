/**
 * The build: `next build`, then pending database migrations on production
 * deploys, then a check that the database is ready for this version.
 *
 * Migrations run after the app has built, so a build that fails never leaves
 * the database ahead of the live version, and the previous version meets the
 * new database only for the moments it takes the new one to go live.
 *
 * Migrations run only on production deploys (VERCEL_ENV=production), so
 * previews and local builds never touch the production database, and only
 * when the host has the database connection string (SUPABASE_DB_URL or
 * DATABASE_URL). An Owner can turn them off in Settings > Updates, and
 * MIGRATE_ON_DEPLOY=false on the host turns them off whatever the switch says.
 * A failed migration fails the build, and the live deployment stays as it was.
 * Every core migration is written to be safe alongside the previous release's code.
 *
 *   npm run build -- [next build options]
 */
import { spawnSync } from 'node:child_process';
import type { CopyResult } from '../src/lib/supabase/storage-copy';
import { BUCKETS } from '../src/lib/supabase/schema';

export function shouldMigrate(env: NodeJS.ProcessEnv): boolean {
  if (env.VERCEL_ENV !== 'production') return false;
  if (env.MIGRATE_ON_DEPLOY?.trim().toLowerCase() === 'false') return false;
  // MIGRATE_ON_DEPLOY=true without a connection string still tries, so the build says what is missing.
  return Boolean(env.DATABASE_URL?.trim() || env.SUPABASE_DB_URL?.trim()) || env.MIGRATE_ON_DEPLOY === 'true';
}

export type PmState = 'ready' | 'not_exposed' | 'not_moved' | 'unknown';

/**
 * Whether this version's database is in place: the app's tables in schema
 * pm, served by Supabase's API. Asked through the API with the service key,
 * so it works with or without the database connection string.
 */
export async function pmState(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<PmState> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return 'unknown';
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/business_settings?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'pm' },
    });
    if (response.ok) return 'ready';
    const body = await response.json().catch(() => ({})) as { code?: string };
    if (body.code === 'PGRST106') return 'not_exposed';
    if (body.code === 'PGRST205' || body.code === '42P01') return 'not_moved';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * pmState once Supabase's API has caught up. It reloads its schema a moment
 * after a migration commits, so a database moved seconds ago can still look
 * unmoved: ask again for up to about 30 seconds before believing it.
 */
export async function settledPmState(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  { tries = 10, delayMs = 3000 }: { tries?: number; delayMs?: number } = {},
): Promise<PmState> {
  let state = await pmState(env, fetchImpl);
  for (let i = 1; i < tries && (state === 'not_exposed' || state === 'not_moved'); i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state = await pmState(env, fetchImpl);
  }
  return state;
}

const NOT_EXPOSED = 'This version needs Supabase to share the pm and pm_custom schemas: in Supabase, Project Settings, Data API, add them to Exposed schemas, then redeploy. The live version keeps running.';
const NOT_MOVED = 'This version needs the database moved into schema pm: run npm run db:migrate (or turn on automatic database updates in Settings > Updates), then redeploy. The live version keeps running.';

async function build(): Promise<number> {
  // Production only: a database that cannot serve this version, and that this
  // build will not update, stops the deploy before anything changes. (When it
  // will update, the migrations may be what shares the schemas: checked after.)
  const production = process.env.VERCEL_ENV === 'production';
  const migrating = shouldMigrate(process.env);
  if (production && !migrating && (await pmState(process.env)) === 'not_exposed') {
    console.error(NOT_EXPOSED);
    return 1;
  }

  const next = require.resolve('next/dist/bin/next');
  const result = spawnSync(process.execPath, [next, 'build', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;

  if (migrating) {
    console.log('Production deploy: applying database updates, unless an Owner turned them off.');
    // Loaded only here, so a plain build never needs the database driver.
    const { main: migrate, reportError } = await import('./db-migrate');
    try {
      const code = await migrate(['--if-enabled']);
      if (code !== 0) return code;
    } catch (err) {
      reportError(err);
      return 1;
    }
  } else if (process.env.VERCEL_ENV && !production) {
    console.log(`Not a production deploy (VERCEL_ENV=${process.env.VERCEL_ENV}): database updates are skipped.`);
  }

  if (production) {
    const state = await settledPmState(process.env);
    if (state === 'not_exposed' || state === 'not_moved') {
      console.error(state === 'not_exposed' ? NOT_EXPOSED : NOT_MOVED);
      return 1;
    }
  }
  if (production && !(await copyFiles())) return 1;
  return 0;
}

/**
 * Installs from before 2.0: files in the old storage buckets are copied into
 * the pm- ones, with one retry for any that failed. Most files fall back to
 * the old bucket when read, so their failures never stop the deploy (the next
 * deploy, or npm run storage:copy-to-pm, copies what is left). The brand's
 * logos are the exception: their public links point at pm-brand, so a logo
 * that did not copy stops the deploy, and the live version keeps running.
 */
export async function copyFiles(
  env: NodeJS.ProcessEnv = process.env,
  copy?: (log: (line: string) => void) => Promise<CopyResult[]>,
): Promise<boolean> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!copy && (!url || !key)) return true;
  const run = copy ?? (async (log: (line: string) => void) => {
    const { createClient } = await import('@supabase/supabase-js');
    const { copyLegacyBuckets } = await import('../src/lib/supabase/storage-copy');
    return copyLegacyBuckets(createClient(url!, key!, { auth: { persistSession: false } }), log);
  });
  const log = (line: string) => console.log(`Storage: ${line}`);
  let results: CopyResult[] | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      results = await run(log);
      if (!results.some((r) => r.failed.length)) return true;
    } catch (err) {
      results = null;
      log(`copying files to the pm- buckets did not finish (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const brandFailed = results === null || results.some((r) => r.bucket === BUCKETS.brand && r.failed.length > 0);
  if (brandFailed) {
    console.error(BRAND_NOT_COPIED);
    return false;
  }
  log('some files did not copy; they are read from the old buckets meanwhile.');
  return true;
}

const BRAND_NOT_COPIED = 'This version shows the brand logos from the pm-brand storage bucket, and copying them there did not finish. Redeploy to try again, or run npm run storage:copy-to-pm. The live version keeps running.';

if (require.main === module) {
  build().then(
    code => process.exit(code),
    err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
