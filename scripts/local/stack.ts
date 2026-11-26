/** Shared bits of the local test stack scripts (up, seed, down). */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_DIR = __dirname;
export const ENV_FILE = join(LOCAL_DIR, '.env.test.local');
export const LOCAL = {
  appPort: 3010,
  dbContainer: 'supabase_db_pm-local',
  /** Pinned so every machine runs the same CLI. */
  cli: 'supabase@3.4.0',
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Stops the script unless the URL is this machine's. */
export function assertLocal(value: string | undefined, name: string): void {
  let host = '';
  try {
    host = new URL(value ?? '').hostname;
  } catch {
    // falls through
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${name} is not on this machine (${host || 'unset'}). The local scripts only ever use 127.0.0.1.`);
}

/** Runs the Supabase CLI against scripts/local; answers stdout. */
export function supabase(args: string[], options: { inherit?: boolean; allowFail?: boolean } = {}): string {
  // npx runs from the package root, so the workdir is absolute. Windows needs a
  // shell for npx.cmd, and the shell would split a path with spaces: quoted.
  const win = process.platform === 'win32';
  const quote = (arg: string) => (win && /\s/.test(arg) ? `"${arg}"` : arg);
  const result = spawnSync('npx', ['--yes', LOCAL.cli, ...args, '--workdir', LOCAL_DIR].map(quote), {
    encoding: 'utf8',
    shell: win,
    stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`supabase ${args.join(' ')} failed${result.stderr ? `:\n${result.stderr}` : ''}`);
  }
  return result.stdout ?? '';
}

/** KEY=VALUE lines of scripts/local/.env.test.local. */
export function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
