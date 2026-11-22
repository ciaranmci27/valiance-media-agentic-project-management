/**
 * Installs from before 2.0: copies the files in the old storage buckets into
 * the pm- ones (inside Supabase, keeping paths). Safe to run again. The build
 * runs it after the move on production deploys; this is the same by hand.
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment or .env.local.
 *
 *   npm run storage:copy-to-pm
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const name of ['.env.local', '.env']) {
  const path = join(__dirname, '..', name);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
}

async function main(): Promise<number> {
  const { getServiceClient } = await import('../src/lib/api/supabase-service');
  const { copyLegacyBuckets } = await import('../src/lib/supabase/storage-copy');
  const results = await copyLegacyBuckets(getServiceClient(), (line) => console.log(line));
  if (!results.length) console.log('No old buckets to copy from.');
  const failed = results.reduce((n, r) => n + r.failed.length, 0);
  if (failed) console.log(`${failed} file(s) failed to copy; run it again. They stay readable from the old bucket meanwhile.`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
