/**
 * npm run test:e2e: the app proven end to end as it is used, over real HTTP,
 * against the local test stack (Supabase in Docker, scripts/local/README.md).
 * Not part of test:core: it needs Docker and a seeded stack.
 *
 *   npm run test:e2e                  every scenario, on a server this run starts
 *   npm run test:e2e -- 2 3           only scenarios 2 and 3 (number or file name)
 *   E2E_BASE_URL=http://localhost:3011 npm run test:e2e   reuse a running local server
 *
 * The server it starts is scripts/local/dev.mjs (the same one as
 * npm run local:dev, so guard-env.cjs keeps production out) on the first free
 * port from 3011, with PM_E2E=1 so it never reaches a chat provider. It is
 * stopped at the end. Each scenario seeds its own data and cleans up after
 * itself, pass or fail. Exit code 0 only when every scenario passed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { listMigrationFiles, migrationDirs, migrationStatus, type MigrationDb } from '../lib/migrations';
import { Cleanup, E2EFailure, assertLocal, http, preparePeople, readStackEnv, stepsLogged, type Ctx } from './harness';
import hireAgent from './01-hire-agent';
import chatToDone from './02-chat-to-done';
import whoCanUse from './03-who-can-use';
import templatesSchedules from './04-templates-schedules';
import files from './05-files';
import keys from './06-keys';
import guests from './07-guests';

export interface Scenario {
  name: string;
  run: (ctx: Ctx) => Promise<void>;
}

const SCENARIOS: Scenario[] = [hireAgent, chatToDone, whoCanUse, templatesSchedules, files, keys, guests];
const APP_DIR = join(__dirname, '..', '..');

async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port from ${from}`);
}

function stopServer(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  // dev.mjs runs Next as its own child: take the whole tree down.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGINT');
}

async function startServer(): Promise<{ baseUrl: string; child: ChildProcess; log: string }> {
  const port = await freePort(3011);
  const log = join(tmpdir(), `pm-e2e-server-${port}.log`);
  const out = createWriteStream(log);
  const child = spawn(process.execPath, [join(APP_DIR, 'scripts', 'local', 'dev.mjs')], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(port), PM_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The local server stopped (code ${child.exitCode}). Its log: ${log}`);
    try {
      const answer = await http(baseUrl, '/login');
      if (answer.status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() > deadline) {
      stopServer(child);
      throw new Error(`The local server did not answer within 3 minutes. Its log: ${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { baseUrl, child, log };
}

async function preflight(db: Client): Promise<void> {
  const migrationDb: MigrationDb = {
    async query<T>(sql: string, params?: unknown[]) { return (await db.query(sql, params)).rows as T[]; },
    async exec(sql: string) { await db.query(sql); },
  };
  const status = await migrationStatus(migrationDb, listMigrationFiles(migrationDirs(APP_DIR)));
  if (status.pending.length) {
    throw new Error(`The local database is missing ${status.pending.length} migration(s) (${status.pending.slice(0, 3).map((file) => file.name).join(', ')}...). Run npm run local:up.`);
  }
  const off = (await db.query(`SELECT module_id FROM pm.workspace_modules WHERE NOT enabled AND module_id IN ('agents', 'portal', 'webhooks')`)).rows;
  if (off.length) throw new Error(`Modules switched off on the local stack: ${off.map((row) => row.module_id).join(', ')}. Run npm run local:seed or switch them on in Settings.`);
}

/** Dependencies the server cannot load (a broken install): the routes that import them answer 500. */
function missingPackages(): string[] {
  const require = createRequire(join(APP_DIR, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {}).filter((name) => {
    try {
      require.resolve(`${name}/package.json`);
      return false;
    } catch (error) {
      return (error as { code?: string }).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED';
    }
  });
}

async function main() {
  const started = Date.now();
  const filters = process.argv.slice(2);
  const chosen = filters.length
    ? SCENARIOS.filter((scenario, index) => filters.some((filter) => filter === String(index + 1) || scenario.name.toLowerCase().includes(filter.toLowerCase())))
    : SCENARIOS;
  if (chosen.length === 0) throw new Error(`No scenario matches ${filters.join(' ')}`);

  const env = readStackEnv();
  const db = new Client({ connectionString: env.DATABASE_URL, ssl: false });
  await db.connect();
  let server: { baseUrl: string; child: ChildProcess; log: string } | null = null;
  const results: { name: string; ok: boolean; ms: number; error?: string; cleanup: string[] }[] = [];
  try {
    await preflight(db);
    const missing = missingPackages();
    if (missing.length) console.log(`WARNING: node_modules is missing ${missing.join(', ')}: routes that import it answer 500 until it is reinstalled.`);
    let baseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, '');
    if (baseUrl) {
      assertLocal(baseUrl, 'E2E_BASE_URL');
      console.log(`Using the running local server at ${baseUrl}`);
    } else {
      console.log('Starting a local server for this run (scripts/local/dev.mjs)...');
      server = await startServer();
      baseUrl = server.baseUrl;
      console.log(`Local server ready at ${baseUrl} (log: ${server.log})`);
    }
    const people = await preparePeople({ baseUrl, env, db });
    console.log(`Signed in: ${Object.values(people).map((person) => person.name).join(', ')}`);

    for (const scenario of chosen) {
      const number = SCENARIOS.indexOf(scenario) + 1;
      console.log(`\n${number}. ${scenario.name}`);
      const cleanup = new Cleanup();
      const t0 = Date.now();
      let error: string | undefined;
      try {
        await scenario.run({ baseUrl, env, db, people, cleanup });
      } catch (failure) {
        error = failure instanceof E2EFailure ? failure.message : failure instanceof Error ? (failure.stack ?? failure.message) : String(failure);
        console.log(`    FAIL ${error}`);
      }
      const cleanupFailures = await cleanup.runAll();
      for (const line of cleanupFailures) console.log(`    cleanup failed: ${line}`);
      const ms = Date.now() - t0;
      results.push({ name: `${number}. ${scenario.name}`, ok: !error, ms, error, cleanup: cleanupFailures });
      console.log(`    ${error ? 'FAILED' : 'passed'} in ${(ms / 1000).toFixed(1)} s`);
    }
  } finally {
    if (server) stopServer(server.child);
    await db.end().catch(() => {});
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed, ${stepsLogged()} steps, ${((Date.now() - started) / 1000).toFixed(1)} s in all.`);
  for (const result of results) console.log(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name} (${(result.ms / 1000).toFixed(1)} s)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
