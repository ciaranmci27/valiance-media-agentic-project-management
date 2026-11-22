/**
 * The update routes' logic, with session, audit and fetch passed in so the
 * scripts can run every refusal and every GitHub answer without a server.
 *
 * Owner only, by role: an update changes the install's code. POSTs must come
 * from this app's own pages (Origin or Referer names this host). The source
 * install reads releases but never updates itself, and the demo has nothing to
 * update.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { readConnection, UPDATE_SECRET_NAME, UPDATE_WORKFLOW_FILE, installRole, type ConnectionContext, type UpdatesEnv } from './connection';
import { GitHubError, repoPath, sealSecret, withGetMemo, type FetchLike, type GitHubClient } from './github';
import { pendingReleases, readReleases } from './releases';
import { canApply, deriveRun, runTitle, versionToFollow } from './run';
import { parseVersion, type ConnectionInfo, type ReleaseInfo, type UpdateRun, type UpdatesState } from './types';
import { databaseUpdates, type DatabaseEnv, type DatabaseUpdates } from './database';

export type AuthResult =
  | { error: NextResponse; memberId?: undefined; role?: undefined }
  | { error: null; memberId: string; role: string };

export interface AuditEntry {
  method: 'POST';
  endpoint: string;
  request_body: Record<string, unknown>;
  before_snapshot: unknown;
  after_snapshot: unknown;
  status_code: number;
  memberId: string;
}

/** The database side of updates: the Owner's switch and what the migration runner recorded. */
export interface DatabaseStore {
  /** switchOn null: the setting is not there yet. applied null: no record kept (the runner never ran). */
  read: () => Promise<{ switchOn: boolean | null; applied: string[] | null; schemas?: 'ready' | 'not_exposed' | 'unknown' }>;
  save: (on: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface UpdatesDeps {
  env: UpdatesEnv & DatabaseEnv & { NEXT_PUBLIC_DEMO_MODE?: string; DEMO_MODE?: string };
  database?: DatabaseStore;
  authorize: () => Promise<AuthResult>;
  audit: (entry: AuditEntry) => void;
  currentVersion: () => string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ENDPOINT = '/api/workspace/updates';
const SOURCE_MESSAGE = 'This is the source install: releases are published from here, so it does not update itself.';
/** Stages where a new Prepare would only get in the way. */
const BUSY_STAGES = new Set<UpdateRun['stage']>(['preparing', 'ready', 'waiting_approval', 'applying', 'applied']);

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

function isDemo(env: UpdatesDeps['env']): boolean {
  return env.NEXT_PUBLIC_DEMO_MODE === 'true' || env.DEMO_MODE === 'true';
}

/** True only when Origin, or failing that Referer, names this host. A request naming neither is refused. */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const source = origin && origin !== 'null' ? origin : request.headers.get('referer');
  if (!source) return false;
  let host: string;
  try {
    host = new URL(source).host;
  } catch {
    return false;
  }
  const hosts = [request.nextUrl.host, request.headers.get('host'), request.headers.get('x-forwarded-host')].filter(Boolean);
  return hosts.includes(host);
}

async function ownerOnly(deps: UpdatesDeps): Promise<{ error: NextResponse } | { error: null; memberId: string }> {
  const auth = await deps.authorize();
  if (auth.error) return { error: auth.error };
  if (auth.role !== 'owner') return { error: fail(403, 'Owner access required') };
  return { error: null, memberId: auth.memberId };
}

/** The checks every POST runs, in order: demo, origin, owner, source install. */
async function guardPost(request: NextRequest, deps: UpdatesDeps): Promise<{ error: NextResponse } | { error: null; memberId: string }> {
  if (isDemo(deps.env)) return { error: fail(403, 'The demo workspace does not update.') };
  if (!isSameOrigin(request)) return { error: fail(403, 'Cross-site request refused') };
  const owner = await ownerOnly(deps);
  if (owner.error) return owner;
  if (installRole(deps.env) === 'source') return { error: fail(409, SOURCE_MESSAGE) };
  return owner;
}

async function readVersion(request: NextRequest): Promise<string | NextResponse> {
  let body: { version?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Send a JSON body with the version');
  }
  const version = parseVersion(body?.version);
  return version ?? fail(400, 'version must be a release version like 1.4.0');
}

function connectionFor(deps: UpdatesDeps, reuse = false): Promise<ConnectionContext> {
  return readConnection({ env: deps.env, fetch: deps.fetch, reuse });
}

/** Statuses where the repo is open with the token and its runs can be read. */
const RUN_READABLE = new Set<ConnectionInfo['status']>(['workflow_missing', 'merge_commits_disabled', 'secret_missing', 'connected']);

/** The install's token reads the upstream releases (60 anonymous reads an hour per IP is easy to share away); the source install reads anonymously. */
function releaseToken(deps: UpdatesDeps): string | null {
  return installRole(deps.env) === 'source' ? null : deps.env.PM_GITHUB_TOKEN?.trim() || null;
}

/** The pending release for a version, read again once before refusing (a release published since the cached read). */
async function findPendingRelease(version: string, deps: UpdatesDeps): Promise<ReleaseInfo | NextResponse> {
  const current = deps.currentVersion();
  const token = releaseToken(deps);
  let list = await readReleases({ fetch: deps.fetch, now: deps.now, token });
  let release = pendingReleases(list.releases, current).find((item) => item.version === version) ?? null;
  if (!release) {
    list = await readReleases({ refresh: true, fetch: deps.fetch, now: deps.now, token });
    release = pendingReleases(list.releases, current).find((item) => item.version === version) ?? null;
  }
  if (release) return release;
  if (list.error) return fail(503, list.error);
  return fail(400, `v${version} is not a newer release for this install (running v${current}).`);
}

export async function getUpdates(request: NextRequest, deps: UpdatesDeps): Promise<NextResponse> {
  if (isDemo(deps.env)) return fail(403, 'The demo workspace does not update.');
  const owner = await ownerOnly(deps);
  if (owner.error) return owner.error;

  const role = installRole(deps.env);
  const current = deps.currentVersion();
  const refresh = request.nextUrl.searchParams.get('refresh') === '1';
  const [list, connection, database] = await Promise.all([
    readReleases({ refresh, fetch: deps.fetch, now: deps.now, token: releaseToken(deps) }),
    role === 'source' ? Promise.resolve(null) : connectionFor(deps, !refresh),
    readDatabase(deps),
  ]);
  const pending = pendingReleases(list.releases, current);

  let run: UpdateRun | null = null;
  if (connection?.client && connection.repo && connection.defaultBranch && RUN_READABLE.has(connection.info.status)) {
    try {
      const gh = withGetMemo(connection.client);
      const version = await versionToFollow(gh, connection.repo, pending);
      if (version) {
        run = await deriveRun(gh, connection.repo, version, {
          defaultBranch: connection.defaultBranch,
          release: pending.find((release) => release.version === version) ?? null,
          now: deps.now,
        });
      }
    } catch (error) {
      console.error('[updates] reading the update run failed:', error instanceof Error ? error.message : 'unknown error');
    }
  }

  const state: UpdatesState = {
    role,
    current,
    latest: list.releases[0] ?? null,
    pending,
    checkedAt: list.checkedAt,
    releasesError: list.error,
    connection: connection?.info ?? null,
    run,
    database,
  };
  return NextResponse.json({ data: state });
}

async function readDatabase(deps: UpdatesDeps): Promise<DatabaseUpdates | null> {
  if (!deps.database) return null;
  try {
    return databaseUpdates(deps.env, await deps.database.read());
  } catch (error) {
    console.error('[updates] reading the database state failed:', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

/**
 * Owners turn automatic database updates on or off (Settings > Updates). The
 * source install has the switch too: it deploys like any other. Answers the
 * database state as it now is.
 */
export async function postDatabase(request: NextRequest, deps: UpdatesDeps): Promise<NextResponse> {
  if (isDemo(deps.env)) return fail(403, 'The demo workspace does not update.');
  if (!isSameOrigin(request)) return fail(403, 'Cross-site request refused');
  const owner = await ownerOnly(deps);
  if (owner.error) return owner.error;
  if (!deps.database) return fail(503, 'Database updates are not available here.');
  const body = await request.json().catch(() => null) as { automatic?: unknown } | null;
  if (typeof body?.automatic !== 'boolean') return fail(400, 'Send { automatic: true } or { automatic: false }.');

  const before = await readDatabase(deps);
  const saved = await deps.database.save(body.automatic);
  if (!saved.ok) return fail(500, saved.message);
  const after = await readDatabase(deps);
  deps.audit({
    method: 'POST',
    endpoint: `${ENDPOINT}/database`,
    request_body: { automatic: body.automatic },
    before_snapshot: before && { mode: before.mode, switchOn: before.switchOn },
    after_snapshot: after && { mode: after.mode, switchOn: after.switchOn },
    status_code: 200,
    memberId: owner.memberId,
  });
  return NextResponse.json({ data: after });
}

export async function postSetup(request: NextRequest, deps: UpdatesDeps): Promise<NextResponse> {
  const guard = await guardPost(request, deps);
  if (guard.error) return guard.error;

  const before = await connectionFor(deps);
  if (!before.client || !before.repo || !RUN_READABLE.has(before.info.status)) {
    return fail(409, before.info.message ?? 'Connect the repository first.');
  }
  const token = deps.env.PM_GITHUB_TOKEN?.trim() ?? '';
  try {
    await storeSecret(before.client, before.repo, token);
  } catch (error) {
    if (error instanceof GitHubError && (error.kind === 'forbidden' || error.kind === 'not_found')) {
      return fail(409, 'The token cannot store Actions secrets. Give it Secrets: Read and write, then try again.');
    }
    return fail(502, error instanceof GitHubError ? error.message : 'Could not store the secret on GitHub.');
  }

  const after = await connectionFor(deps);
  deps.audit({
    method: 'POST',
    endpoint: `${ENDPOINT}/setup`,
    request_body: { secret: UPDATE_SECRET_NAME },
    before_snapshot: { connection: before.info },
    after_snapshot: { connection: after.info },
    status_code: 200,
    memberId: guard.memberId,
  });
  return NextResponse.json({ data: after.info });
}

/** Writes the Actions secret: the value sealed with the repo's public key, never sent in the clear. */
async function storeSecret(gh: GitHubClient, repo: string, value: string): Promise<void> {
  if (!value) throw new Error('PM_GITHUB_TOKEN is not set');
  const key = (await gh.request<{ key_id?: string; key?: string }>(repoPath(repo, '/actions/secrets/public-key'))).data;
  if (!key?.key || !key.key_id) throw new GitHubError('server', 0, 'GitHub sent no public key for the repository secrets.');
  const encrypted = await sealSecret(key.key, value);
  await gh.request(repoPath(repo, `/actions/secrets/${UPDATE_SECRET_NAME}`), {
    method: 'PUT',
    body: { encrypted_value: encrypted, key_id: key.key_id },
  });
}

function placeholderRun(version: string, release: ReleaseInfo | null, now: Date): UpdateRun {
  return {
    version,
    stage: 'preparing',
    workflowRunUrl: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    headSha: null,
    previewUrl: null,
    checks: [],
    conflictFiles: [],
    hasMigrations: release?.hasMigrations ?? false,
    updatedAt: now.toISOString(),
  };
}

function busyMessage(run: UpdateRun): string {
  switch (run.stage) {
    case 'applied': return `v${run.version} is already applied. Your host deploys it next.`;
    case 'ready':
    case 'waiting_approval': return `v${run.version} is already prepared. Apply it, or close its pull request on GitHub to start again.`;
    default: return `v${run.version} is already being prepared.`;
  }
}

export async function postPrepare(request: NextRequest, deps: UpdatesDeps): Promise<NextResponse> {
  const guard = await guardPost(request, deps);
  if (guard.error) return guard.error;
  const version = await readVersion(request);
  if (version instanceof NextResponse) return version;

  const release = await findPendingRelease(version, deps);
  if (release instanceof NextResponse) return release;

  const connection = await connectionFor(deps);
  if (connection.info.status !== 'connected' || !connection.client || !connection.repo || !connection.defaultBranch) {
    return fail(409, connection.info.message ?? 'Connect the repository first.');
  }
  const gh = connection.client;
  const repo = connection.repo;
  const defaultBranch = connection.defaultBranch;
  const now = deps.now ?? (() => new Date());

  const before = await deriveRun(gh, repo, version, { defaultBranch, release, now });
  if (before && BUSY_STAGES.has(before.stage)) return fail(409, busyMessage(before));

  try {
    await gh.request(repoPath(repo, `/actions/workflows/${UPDATE_WORKFLOW_FILE}/dispatches`), {
      method: 'POST',
      body: { ref: connection.defaultBranch, inputs: { version } },
    });
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'forbidden') {
      return fail(409, 'The token cannot start workflows. Give it Actions: Read and write, then try again.');
    }
    if (error instanceof GitHubError && error.kind === 'not_found') {
      return fail(409, `The update workflow (${UPDATE_WORKFLOW_FILE}) was not found on ${connection.defaultBranch}.`);
    }
    return fail(502, error instanceof GitHubError ? `GitHub did not start the update: ${error.message}` : 'GitHub did not start the update.');
  }

  // GitHub lists a dispatched run within a few seconds; wait briefly for it.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let run: UpdateRun | null = null;
  for (let attempt = 0; attempt < 4 && !run; attempt++) {
    await sleep(1500);
    try {
      const found = await deriveRun(gh, repo, version, { defaultBranch, release, now });
      if (found && found.stage === 'preparing' && found.workflowRunUrl && found.workflowRunUrl !== before?.workflowRunUrl) run = found;
    } catch {
      break;
    }
  }
  run ??= placeholderRun(version, release, now());

  deps.audit({
    method: 'POST',
    endpoint: `${ENDPOINT}/prepare`,
    request_body: { version, workflow: UPDATE_WORKFLOW_FILE, title: runTitle(version) },
    before_snapshot: { run: before },
    after_snapshot: { run },
    status_code: 200,
    memberId: guard.memberId,
  });
  return NextResponse.json({ data: run });
}

function notReadyMessage(run: UpdateRun | null, version: string): string {
  if (!run) return `v${version} has not been prepared yet.`;
  switch (run.stage) {
    case 'preparing': return `v${version} is still being prepared.`;
    case 'conflict': return `v${version} conflicts with changes in your repository, so it cannot be applied.`;
    case 'no_shared_history': return 'Your repository does not share the public history, so updates cannot be applied.';
    case 'checks_failed': return `Checks failed for v${version}, so it cannot be applied.`;
    case 'waiting_approval': return `v${version} needs an approving review on GitHub first${run.pullRequestUrl ? `: ${run.pullRequestUrl}` : '.'}`;
    case 'applied': return `v${version} is already applied.`;
    case 'ready': return `Not every check has passed for v${version} yet. Apply once they pass.`;
    default: return `v${version} is not ready to apply.`;
  }
}

export async function postApply(request: NextRequest, deps: UpdatesDeps): Promise<NextResponse> {
  const guard = await guardPost(request, deps);
  if (guard.error) return guard.error;
  const version = await readVersion(request);
  if (version instanceof NextResponse) return version;
  // Only a published release newer than this install, as Prepare requires.
  const release = await findPendingRelease(version, deps);
  if (release instanceof NextResponse) return release;

  const connection = await connectionFor(deps);
  if (connection.info.status !== 'connected' || !connection.client || !connection.repo || !connection.defaultBranch) {
    return fail(409, connection.info.message ?? 'Connect the repository first.');
  }
  const gh = connection.client;
  const repo = connection.repo;
  const now = deps.now ?? (() => new Date());

  const before = await deriveRun(gh, repo, version, { defaultBranch: connection.defaultBranch, release, now });
  if (!canApply(before)) return fail(409, notReadyMessage(before, version));

  let after: UpdateRun;
  const status = 200;
  try {
    // A merge commit, never squash or rebase: the release's history stays in
    // the install, so the next release merges cleanly. sha pins the merge to
    // the commit the checks ran on.
    const merged = await gh.request<{ merged?: boolean; message?: string }>(repoPath(repo, `/pulls/${before.pullRequestNumber}/merge`), {
      method: 'PUT',
      body: { merge_method: 'merge', sha: before.headSha, commit_title: `${runTitle(version)} (#${before.pullRequestNumber})` },
    });
    if (merged.data?.merged !== true) return fail(502, merged.data?.message || 'GitHub did not merge the update.');
    after = { ...before, stage: 'applied', updatedAt: now().toISOString() };
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'invalid' && error.status === 405) {
      if (/merge commits? (are|is) not allowed/i.test(error.message)) {
        return fail(409, 'The repository does not allow merge commits. Turn on Allow merge commits in its Settings > General, then apply again.');
      }
      // Branch protection: a review or rule must be met on GitHub first.
      after = { ...before, stage: 'waiting_approval', updatedAt: now().toISOString() };
    } else if (error instanceof GitHubError && error.kind === 'invalid' && error.status === 409) {
      return fail(409, 'The update branch changed since its checks ran. Check again, then apply.');
    } else if (error instanceof GitHubError && error.kind === 'forbidden') {
      return fail(409, 'The token cannot merge. Give it Contents and Pull requests: Read and write, then try again.');
    } else {
      return fail(502, error instanceof GitHubError ? `GitHub did not merge the update: ${error.message}` : 'GitHub did not merge the update.');
    }
  }

  deps.audit({
    method: 'POST',
    endpoint: `${ENDPOINT}/apply`,
    request_body: { version, pullRequestNumber: before.pullRequestNumber, sha: before.headSha, merge_method: 'merge' },
    before_snapshot: { run: before },
    after_snapshot: { run: after },
    status_code: status,
    memberId: guard.memberId,
  });
  return NextResponse.json({ data: after }, { status });
}
