/**
 * Whether this install can update itself from GitHub: read from the host's
 * environment and the repo, worst problem first, fresh on every request.
 *
 * Env (set in the host, never in the app's database):
 *   PM_GITHUB_TOKEN   a fine-grained token for this install's repo only (secret)
 *   PM_GITHUB_REPO    owner/name of this install's repo
 *   PM_INSTALL_ROLE   "source" on the install releases are published from
 *   PM_SOURCE_LAYOUT  "1" when next.config.ts found the monorepo layout at build time
 *
 * Fine-grained tokens have no Checks permission, so nothing here reads check
 * runs or annotations: checks come from the Actions API and commit statuses.
 */
import { createHash } from 'node:crypto';
import { createGitHubClient, GitHubError, isValidRepo, repoPath, type FetchLike, type GitHubClient } from './github';
import { REQUIRED_TOKEN_PERMISSIONS, type ConnectionInfo, type InstallRole } from './types';

export const UPDATE_WORKFLOW_FILE = 'core-update.yml';
export const UPDATE_WORKFLOW_PATH = `.github/workflows/${UPDATE_WORKFLOW_FILE}`;
export const UPDATE_SECRET_NAME = 'PM_UPDATE_TOKEN';

export type UpdatesEnv = Partial<Record<'PM_GITHUB_TOKEN' | 'PM_GITHUB_REPO' | 'PM_INSTALL_ROLE' | 'PM_SOURCE_LAYOUT', string | undefined>>;

/** The source install says so (PM_INSTALL_ROLE=source) or was built inside the monorepo (PM_SOURCE_LAYOUT=1). */
export function installRole(env: UpdatesEnv): InstallRole {
  if (env.PM_INSTALL_ROLE?.trim().toLowerCase() === 'source') return 'source';
  return env.PM_SOURCE_LAYOUT?.trim() === '1' ? 'source' : 'install';
}

export interface ConnectionContext {
  info: ConnectionInfo;
  /** Set once the repo could be opened with the token. */
  client: GitHubClient | null;
  repo: string | null;
  defaultBranch: string | null;
}

interface RawRepo {
  default_branch?: unknown;
  allow_merge_commit?: unknown;
}

interface RawWorkflow {
  state?: unknown;
}

/** A branch name as a URL path, each part encoded. */
export function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * A ref name git forbids (".." and "~" are never allowed in a ref, see
 * git-check-ref-format), so no branch, tag or ref by this name can exist or
 * be created. Every write probe aims at it.
 */
export const PROBE_REF = 'pm..permission-check~';
/** A secret name GitHub forbids (names must not start with GITHUB_), so it can never be stored. */
export const PROBE_SECRET_NAME = 'GITHUB_PM_PERMISSION_CHECK';

/**
 * One read per permission the token needs, as before write tests existed. A
 * refusal here blocks updates: the token cannot even read what an update needs.
 */
function readProbes(repo: string, branch: string): Array<{ name: string; path: string }> {
  const ref = refPath(branch);
  return [
    { name: 'Contents', path: repoPath(repo, `/commits?per_page=1&sha=${encodeURIComponent(branch)}`) },
    { name: 'Pull requests', path: repoPath(repo, '/pulls?per_page=1') },
    { name: 'Actions', path: repoPath(repo, '/actions/workflows?per_page=1') },
    { name: 'Secrets', path: repoPath(repo, '/actions/secrets/public-key') },
    { name: 'Commit statuses', path: repoPath(repo, `/commits/${ref}/status`) },
    { name: 'Deployments', path: repoPath(repo, '/deployments?per_page=1') },
  ];
}

interface WriteProbe { name: string; path: string; method: 'POST' | 'PUT'; body: Record<string, unknown> }

/**
 * One write test per Read and write permission, each invalid by construction
 * so it can never succeed and nothing in the repo ever changes. With write
 * access GitHub should answer a validation error (422, 404 or 400); without
 * it, 403 "Resource not accessible by personal access token".
 *
 * That GitHub checks the permission before the input is what we expect, not
 * something its docs promise, so these only warn (`permissions_unconfirmed`)
 * and never block an update.
 *
 * Workflows is not here: it is checked when an update changes a workflow file,
 * which no invalid request reaches. Metadata is proven by reading the repo.
 */
function writeProbes(repo: string): WriteProbe[] {
  return [
    // Create a ref with a forbidden name, pointing at an object that cannot exist.
    { name: 'Contents', method: 'POST', path: repoPath(repo, '/git/refs'),
      body: { ref: `refs/heads/${PROBE_REF}`, sha: '0'.repeat(40) } },
    // Open a pull request between two branches that cannot exist.
    { name: 'Pull requests', method: 'POST', path: repoPath(repo, '/pulls'),
      body: { title: 'Permission check (never created)', head: PROBE_REF, base: `${PROBE_REF}base` } },
    // Start the update workflow on a ref that cannot exist, without its required version input.
    { name: 'Actions', method: 'POST', path: repoPath(repo, `/actions/workflows/${UPDATE_WORKFLOW_FILE}/dispatches`),
      body: { ref: PROBE_REF } },
    // Store a secret under a forbidden name, with a value and key that are not valid.
    { name: 'Secrets', method: 'PUT', path: repoPath(repo, `/actions/secrets/${PROBE_SECRET_NAME}`),
      body: { encrypted_value: '!', key_id: '!' } },
  ];
}

/** False when GitHub refused the read (403 or 404). Throws on a refused token, a rate limit or an outage. */
async function runReadProbe(client: GitHubClient, path: string): Promise<boolean> {
  try {
    await client.request(path);
    return true;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.kind === 'unauthorized' || isLimitOrOutage(error)) throw error;
    if (isRefusal(error)) return false;
    // Anything else (an empty repo, say) says nothing about the token.
    return true;
  }
}

/**
 * passed: GitHub got as far as validating the input. refused: 403. untested:
 * a rate limit or outage, which says nothing about the token. Throws on a
 * refused token (401), which never counts as having write.
 */
async function runWriteProbe(client: GitHubClient, probe: WriteProbe): Promise<'passed' | 'refused' | 'untested'> {
  try {
    await client.request(probe.path, { method: probe.method, body: probe.body });
    return 'passed';
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.kind === 'unauthorized') throw error;
    if (error.kind === 'forbidden') return 'refused';
    // 400, 404, 405, 409, 422: a validation answer, past the permission check.
    if (error.kind !== 'rate_limited' && error.status >= 400 && error.status < 500) return 'passed';
    if (isLimitOrOutage(error)) return 'untested';
    return 'passed';
  }
}

/** How long a passed write test is reused, per token and repo, whatever the overall status. */
export const WRITE_PROBE_REUSE_MS = 60 * 1000;
const passedWrites = new Map<string, number>();

/** "Pull requests (Read and write)": a permission as the token page names it, with the access it needs. */
function withAccess(name: string): string {
  const access = REQUIRED_TOKEN_PERMISSIONS.find((permission) => permission.name === name)?.access;
  return access ? `${name} (${access})` : name;
}

const isRefusal = (error: unknown) => error instanceof GitHubError && (error.kind === 'forbidden' || error.kind === 'not_found');
const isLimitOrOutage = (error: unknown) =>
  error instanceof GitHubError && (error.kind === 'rate_limited' || error.kind === 'timeout' || error.kind === 'network' || error.kind === 'server');

function info(status: ConnectionInfo['status'], repo: string | null, defaultBranch: string | null, message: string | null, missing: string[] = [], unconfirmed: string[] = []): ConnectionInfo {
  return { status, repo, defaultBranch, missing, unconfirmed, message };
}

/** The warning for write tests that did not pass; null when they all did. */
function unconfirmedMessage(refused: string[], untested: string[]): string | null {
  const list = (names: string[]) => {
    const named = names.map(withAccess);
    return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0];
  };
  const parts: string[] = [];
  if (refused.length) {
    parts.push(`GitHub refused a test for ${list(refused)}. If an update fails at its last step, this is why: give the token that access on GitHub.`);
  }
  if (untested.length) parts.push(`GitHub could not test ${list(untested)} just now. Check again in a moment.`);
  return parts.length ? `${parts.join(' ')} Updates can still run.` : null;
}

/** How long a page poll may reuse a `connected` answer instead of probing GitHub again. */
export const CONNECTED_REUSE_MS = 60 * 1000;

/** Connected answers by a hash of token and repo; only `connected` is kept, so a fix shows at once. */
const connectedCache = new Map<string, { info: ConnectionInfo; expires: number }>();

/** For tests: forget every reused connection and passed write test. */
export function clearConnectionCache(): void {
  connectedCache.clear();
  passedWrites.clear();
}

/**
 * The connection, worst problem first. `reuse` (page polls only) answers from
 * a `connected` result under a minute old; Check connection and every POST
 * read GitHub fresh.
 */
export async function readConnection(options: { env: UpdatesEnv; fetch?: FetchLike; reuse?: boolean }): Promise<ConnectionContext> {
  const token = options.env.PM_GITHUB_TOKEN?.trim() || '';
  const rawRepo = options.env.PM_GITHUB_REPO?.trim() || '';
  const key = token && rawRepo ? createHash('sha256').update(`${token}\n${rawRepo}`).digest('hex') : null;
  if (key && options.reuse) {
    const hit = connectedCache.get(key);
    if (hit && hit.expires > Date.now()) {
      return { info: hit.info, client: createGitHubClient({ token, fetch: options.fetch }), repo: hit.info.repo, defaultBranch: hit.info.defaultBranch };
    }
  }
  const context = await probeConnection(options.env, options.fetch, key);
  if (key) {
    if (context.info.status === 'connected') connectedCache.set(key, { info: context.info, expires: Date.now() + CONNECTED_REUSE_MS });
    else connectedCache.delete(key);
  }
  return context;
}

async function probeConnection(env: UpdatesEnv, fetchImpl: FetchLike | undefined, cacheKey: string | null): Promise<ConnectionContext> {
  const token = env.PM_GITHUB_TOKEN?.trim() || '';
  const rawRepo = env.PM_GITHUB_REPO?.trim() || '';
  const repo = rawRepo || null;
  const done = (connection: ConnectionInfo, client: GitHubClient | null = null): ConnectionContext => ({
    info: connection, client, repo: connection.repo, defaultBranch: connection.defaultBranch,
  });

  if (!token || !rawRepo) {
    const unset = [!token && 'PM_GITHUB_TOKEN', !rawRepo && 'PM_GITHUB_REPO'].filter(Boolean).join(' and ');
    return done(info('not_configured', repo, null, `Set ${unset} in your host's environment settings, then redeploy.`));
  }
  if (!isValidRepo(rawRepo)) {
    return done(info('repo_unreachable', repo, null, 'PM_GITHUB_REPO must be the repository as owner/name, for example acme/project-management.'));
  }

  const client = createGitHubClient({ token, fetch: fetchImpl });
  try {
    let repoData: RawRepo;
    try {
      repoData = (await client.request<RawRepo>(repoPath(rawRepo))).data ?? {};
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'unauthorized') {
        return done(info('token_invalid', rawRepo, null, 'GitHub refused PM_GITHUB_TOKEN. It may have expired: create a new token and update the variable in your host.'));
      }
      if (isRefusal(error)) {
        return done(info('repo_unreachable', rawRepo, null, `The token cannot open ${rawRepo}. Check PM_GITHUB_REPO, and that the token was created for that repository.`));
      }
      throw error;
    }
    const defaultBranch = typeof repoData.default_branch === 'string' && repoData.default_branch ? repoData.default_branch : null;
    if (!defaultBranch) return done(info('repo_unreachable', rawRepo, null, `${rawRepo} has no default branch yet. Push your code to it first.`));

    // Reads block; write tests only warn. A write test that passed within the
    // last minute is not sent again.
    const now = Date.now();
    const [reads, writes] = await Promise.all([
      Promise.all(readProbes(rawRepo, defaultBranch).map(async (probe) => ((await runReadProbe(client, probe.path)) ? null : probe.name))),
      Promise.all(writeProbes(rawRepo).map(async (probe) => {
        const cached = cacheKey ? `${cacheKey}\n${probe.name}` : null;
        if (cached && (passedWrites.get(cached) ?? 0) > now) return { name: probe.name, result: 'passed' as const };
        const result = await runWriteProbe(client, probe);
        if (cached && result === 'passed') passedWrites.set(cached, Date.now() + WRITE_PROBE_REUSE_MS);
        return { name: probe.name, result };
      })),
    ]);
    const missing = reads.filter((name): name is string => name !== null);
    const refused = writes.filter((probe) => probe.result === 'refused' && !missing.includes(probe.name)).map((probe) => probe.name);
    const untested = writes.filter((probe) => probe.result === 'untested' && !missing.includes(probe.name)).map((probe) => probe.name);
    const unconfirmed = [...refused, ...untested];
    const withWrites = (connection: ConnectionInfo): ConnectionInfo => ({ ...connection, unconfirmed });
    if (missing.length) {
      return done(withWrites(info('missing_permissions', rawRepo, defaultBranch,
        `The token is missing ${missing.length === 1 ? 'this permission' : 'these permissions'}: ${missing.map(withAccess).join(', ')}. Edit the token on GitHub to add ${missing.length === 1 ? 'it' : 'them'}.`, missing)), client);
    }

    // The update workflow, on the branch the host deploys and switched on.
    let workflowMessage: string | null = null;
    try {
      await client.request(repoPath(rawRepo, `/contents/${UPDATE_WORKFLOW_PATH}?ref=${encodeURIComponent(defaultBranch)}`));
      const workflow = (await client.request<RawWorkflow>(repoPath(rawRepo, `/actions/workflows/${UPDATE_WORKFLOW_FILE}`))).data;
      if (workflow?.state !== 'active') workflowMessage = `The update workflow is switched off on GitHub. Turn it on in the repository's Actions tab.`;
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'not_found')) throw error;
      workflowMessage = `${UPDATE_WORKFLOW_PATH} is not on ${defaultBranch}. Take this release by hand once (npm run upgrade), or copy the file from the public repo.`;
    }
    if (workflowMessage) return done(withWrites(info('workflow_missing', rawRepo, defaultBranch, workflowMessage)), client);

    if (repoData.allow_merge_commit === false) {
      return done(withWrites(info('merge_commits_disabled', rawRepo, defaultBranch,
        'The repository does not allow merge commits, which updates need to keep the release history. Turn on Allow merge commits in its Settings > General.')), client);
    }

    try {
      await client.request(repoPath(rawRepo, `/actions/secrets/${UPDATE_SECRET_NAME}`));
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'not_found')) throw error;
      return done(withWrites(info('secret_missing', rawRepo, defaultBranch, 'Finish setup to store the token for the update workflow.')), client);
    }

    // Connected only when every test passed; otherwise a warning that still allows updates.
    const warning = unconfirmedMessage(refused, untested);
    if (warning) return done(withWrites(info('permissions_unconfirmed', rawRepo, defaultBranch, warning)), client);
    return done(info('connected', rawRepo, defaultBranch, null), client);
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'unauthorized') {
      return done(info('token_invalid', rawRepo, null, 'GitHub refused PM_GITHUB_TOKEN. It may have expired: create a new token and update the variable in your host.'));
    }
    const why = error instanceof GitHubError ? error.message : 'Could not reach GitHub.';
    return done(info('repo_unreachable', rawRepo, null, `${why} Check the connection again in a moment.`));
  }
}
