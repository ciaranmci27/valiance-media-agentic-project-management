/**
 * Moves saved email passwords and project credentials from the older keys
 * (SMTP_ENCRYPTION_KEY, PROJECT_CREDENTIALS_ENCRYPTION_KEY) onto
 * APP_ENCRYPTION_KEY: the same as Settings > Workspace > Encryption, for a
 * terminal. Safe to run again. Reads NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY and the keys from the environment or .env.local.
 *
 *   npm run secrets:reencrypt            moves them, then reports what is left
 *   npm run secrets:reencrypt -- --status   only reports
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

async function main() {
  const { getServiceClient } = await import('../src/lib/api/supabase-service');
  const { encryptionStatus, reencryptAll } = await import('../src/lib/crypto/reencrypt');
  const service = getServiceClient();
  if (process.argv.includes('--status')) {
    const status = await encryptionStatus(service);
    console.log(`APP_ENCRYPTION_KEY: ${status.appKey}`);
    console.log(`Still on older keys: ${status.remaining.smtp} email password(s), ${status.remaining.credentials} credential(s); ${status.remaining.webhooks} webhook signing secret(s) not yet encrypted`);
    if (status.legacyKeys.length) console.log(`Older keys still set: ${status.legacyKeys.join(', ')}`);
    return 0;
  }
  const result = await reencryptAll(service);
  console.log(`Moved ${result.moved.smtp} email password(s), ${result.moved.credentials} credential(s) and ${result.moved.webhooks} webhook signing secret(s) to APP_ENCRYPTION_KEY.`);
  const failed = result.failed.smtp.length + result.failed.credentials.length;
  if (failed) console.log(`${failed} could not be opened with the older keys (they are left as they are). Check SMTP_ENCRYPTION_KEY and PROJECT_CREDENTIALS_ENCRYPTION_KEY.`);
  const left = result.status.remaining.smtp + result.status.remaining.credentials + result.status.remaining.webhooks;
  console.log(left ? `${left} still on older keys.` : 'Nothing left on older keys: you can remove SMTP_ENCRYPTION_KEY and PROJECT_CREDENTIALS_ENCRYPTION_KEY.');
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
