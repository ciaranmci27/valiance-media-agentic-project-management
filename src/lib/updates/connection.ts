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
import type { ConnectionInfo, InstallRole } from './types';

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

/** One read per permission the token needs and can be checked without writing. */
function permissionProbes(repo: string, branch: string): Array<{ name: string; path: string }> {
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

const isRefusal = (error: unknown) => error instanceof GitHubError && (error.kind === 'forbidden' || error.kind === 'not_found');
const isLimitOrOutage = (error: unknown) =>
  error instanceof GitHubError && (error.kind === 'rate_limited' || error.kind === 'timeout' || error.kind === 'network' || error.kind === 'server');

function info(status: ConnectionInfo['status'], repo: string | null, defaultBranch: string | null, message: string | null, missing: string[] = []): ConnectionInfo {
  return { status, repo, defaultBranch, missing, message };
}

/** How long a page poll may reuse a `connected` answer instead of probing GitHub again. */
export const CONNECTED_REUSE_MS = 60 * 1000;

/** Connected answers by a hash of token and repo; only `connected` is kept, so a fix shows at once. */
const connectedCache = new Map<string, { info: ConnectionInfo; expires: number }>();

/** For tests: forget every reused connection. */
export function clearConnectionCache(): void {
  connectedCache.clear();
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
  const context = await probeConnection(options.env, options.fetch);
  if (key) {
    if (context.info.status === 'connected') connectedCache.set(key, { info: context.info, expires: Date.now() + CONNECTED_REUSE_MS });
    else connectedCache.delete(key);
  }
  return context;
}

async function probeConnection(env: UpdatesEnv, fetchImpl: FetchLike | undefined): Promise<ConnectionContext> {
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

    const probes = await Promise.all(permissionProbes(rawRepo, defaultBranch).map(async (probe) => {
      try {
        await client.request(probe.path);
        return null;
      } catch (error) {
        if (isRefusal(error)) return probe.name;
        if (isLimitOrOutage(error)) throw error;
        // Anything else (an empty repo, say) says nothing about the token.
        return null;
      }
    }));
    const missing = probes.filter((name): name is string => name !== null);
    if (missing.length) {
      return done(info('missing_permissions', rawRepo, defaultBranch,
        `The token is missing ${missing.length === 1 ? 'this permission' : 'these permissions'}: ${missing.join(', ')}. Edit the token on GitHub to add ${missing.length === 1 ? 'it' : 'them'}.`, missing), client);
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
    if (workflowMessage) return done(info('workflow_missing', rawRepo, defaultBranch, workflowMessage), client);

    if (repoData.allow_merge_commit === false) {
      return done(info('merge_commits_disabled', rawRepo, defaultBranch,
        'The repository does not allow merge commits, which updates need to keep the release history. Turn on Allow merge commits in its Settings > General.'), client);
    }

    try {
      await client.request(repoPath(rawRepo, `/actions/secrets/${UPDATE_SECRET_NAME}`));
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'not_found')) throw error;
      return done(info('secret_missing', rawRepo, defaultBranch, 'Finish setup to store the token for the update workflow.'), client);
    }

    return done(info('connected', rawRepo, defaultBranch, null), client);
  } catch (error) {
    const why = error instanceof GitHubError ? error.message : 'Could not reach GitHub.';
    return done(info('repo_unreachable', rawRepo, null, `${why} Check the connection again in a moment.`));
  }
}
