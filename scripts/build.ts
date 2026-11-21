/**
 * The build: `next build`, with pending database migrations applied first on
 * production deploys that opt in.
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

export function shouldMigrate(env: NodeJS.ProcessEnv): boolean {
  if (env.VERCEL_ENV !== 'production') return false;
  if (env.MIGRATE_ON_DEPLOY?.trim().toLowerCase() === 'false') return false;
  // MIGRATE_ON_DEPLOY=true without a connection string still tries, so the build says what is missing.
  return Boolean(env.DATABASE_URL?.trim() || env.SUPABASE_DB_URL?.trim()) || env.MIGRATE_ON_DEPLOY === 'true';
}

async function build(): Promise<number> {
  if (shouldMigrate(process.env)) {
    console.log('Production deploy: applying database updates first, unless an Owner turned them off.');
    // Loaded only here, so a plain build never needs the database driver.
    const { main: migrate, reportError } = await import('./db-migrate');
    try {
      const code = await migrate(['--if-enabled']);
      if (code !== 0) return code;
    } catch (err) {
      reportError(err);
      return 1;
    }
  } else if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    console.log(`Not a production deploy (VERCEL_ENV=${process.env.VERCEL_ENV}): database updates are skipped.`);
  }
  const next = require.resolve('next/dist/bin/next');
  const result = spawnSync(process.execPath, [next, 'build', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  build().then(
    code => process.exit(code),
    err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
