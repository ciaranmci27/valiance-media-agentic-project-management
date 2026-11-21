/**
 * The build: `next build`, with pending database migrations applied first on
 * production deploys that opt in.
 *
 * Migrations run only when MIGRATE_ON_DEPLOY=true and VERCEL_ENV=production,
 * so previews and local builds never touch the production database. A failed
 * migration fails the build, and the live deployment stays as it was. Every
 * core migration is written to be safe alongside the previous release's code.
 *
 *   npm run build -- [next build options]
 */
import { spawnSync } from 'node:child_process';

export function shouldMigrate(env: NodeJS.ProcessEnv): boolean {
  return env.MIGRATE_ON_DEPLOY === 'true' && env.VERCEL_ENV === 'production';
}

async function build(): Promise<number> {
  if (shouldMigrate(process.env)) {
    console.log('MIGRATE_ON_DEPLOY is on for this production build: applying migrations first.');
    // Loaded only here, so a plain build never needs the database driver.
    const { main: migrate, reportError } = await import('./db-migrate');
    try {
      const code = await migrate([]);
      if (code !== 0) return code;
    } catch (err) {
      reportError(err);
      return 1;
    }
  } else if (process.env.MIGRATE_ON_DEPLOY === 'true') {
    console.log(`MIGRATE_ON_DEPLOY is on, but this is not a production deploy (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}): skipping migrations.`);
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
