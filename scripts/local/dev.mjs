#!/usr/bin/env node
/**
 * The PM app's dev server on the local test stack, never production:
 * `npm run local:dev` (or the launch.json entry app-local), port 3010.
 *
 * Next reads .env.local by itself, and in this folder that file holds the
 * production keys. So the server starts with:
 * - every setting from scripts/local/.env.test.local, and every other setting
 *   the app reads set to empty, passed as real environment variables (they
 *   win over any file);
 * - __NEXT_PROCESSED_ENV set, so Next skips its own .env loading;
 * - guard-env.cjs preloaded into every Node process: .env* files read as
 *   missing (also when one changes while it runs), the process stops unless
 *   Supabase and the database are on this machine, and fetch refuses hosted
 *   Supabase.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..', '..');
const ENV_FILE = join(HERE, '.env.test.local');
const GUARD = join(HERE, 'guard-env.cjs');
const PORT = process.env.PORT || '3010';

if (!existsSync(ENV_FILE)) {
  console.error('No scripts/local/.env.test.local yet. Run npm run local:up first.');
  process.exit(1);
}

/** KEY=VALUE lines; # comments. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const local = parseEnv(readFileSync(ENV_FILE, 'utf8'));
// Seeded logins stay out of the server's environment.
for (const key of Object.keys(local)) if (key.startsWith('LOCAL_')) delete local[key];

const isLocal = (value) => {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};
if (!isLocal(local.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error('scripts/local/.env.test.local must point NEXT_PUBLIC_SUPABASE_URL at 127.0.0.1. Refusing to start.');
  process.exit(1);
}

// Every variable the app or its docs name, empty unless the local file sets
// it: nothing can come from anywhere else.
const KNOWN = [
  'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'APP_ENCRYPTION_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL', 'CRON_SECRET', 'PM_SETUP_CODE', 'MIGRATE_ON_DEPLOY',
  'NEXT_PUBLIC_DEMO_MODE', 'DEMO_MODE', 'INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS', 'WEBHOOKS_ALLOW_PRIVATE_TARGETS',
  'SMTP_ENCRYPTION_KEY', 'PROJECT_CREDENTIALS_ENCRYPTION_KEY', 'RESEND_API_KEY', 'RESEND_INBOUND_WEBHOOK_SECRET',
  'PM_GITHUB_TOKEN', 'PM_GITHUB_REPO', 'PM_INSTALL_ROLE', 'WEBHOOK_SCHEDULER_ENABLED', 'WEBHOOK_SCHEDULER_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VERCEL_URL', 'VERCEL_ENV',
];
const blanks = Object.fromEntries(KNOWN.map((key) => [key, '']));

const guardFlag = `--require "${GUARD.replace(/\\/g, '/')}"`;
const env = {
  ...process.env,
  ...blanks,
  ...local,
  PM_LOCAL_STACK: '1',
  __NEXT_PROCESSED_ENV: 'true',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, guardFlag].filter(Boolean).join(' '),
};

const require = createRequire(join(APP_DIR, 'package.json'));
const nextBin = require.resolve('next/dist/bin/next');

console.log(`[local] PM app on http://localhost:${PORT} using Supabase ${local.NEXT_PUBLIC_SUPABASE_URL} (no .env file is read)`);
const child = spawn(process.execPath, [nextBin, 'dev', '-p', PORT], { cwd: APP_DIR, env, stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
