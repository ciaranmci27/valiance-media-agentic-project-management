/**
 * The shape Settings > Updates reads and the update routes answer with.
 *
 * Nothing about an update is stored in this app's database: GitHub holds the
 * truth (the release list, the update branch, its workflow run, its pull
 * request and checks), and every read derives the state from there.
 */

/** `source`: the install releases are published from (PM_INSTALL_ROLE=source). */
export type InstallRole = 'source' | 'install';

export interface ReleaseInfo {
  /** "1.4.0", no leading v. */
  version: string;
  publishedAt: string;
  /** The release page on GitHub. */
  url: string;
  /** The release notes, markdown (CHANGELOG.md's section for this version). */
  notes: string;
  /** The notes carry a non-empty "### Breaking" section. */
  breaking: boolean;
  /** The notes carry a non-empty "### Database" section: the release changes the database. */
  hasMigrations: boolean;
}

/**
 * Whether this install can update itself from GitHub, worst problem first.
 * Only `connected` and `permissions_unconfirmed` allow Prepare (canUpdate).
 */
export type ConnectionStatus =
  | 'not_configured'        // PM_GITHUB_TOKEN or PM_GITHUB_REPO missing
  | 'token_invalid'         // GitHub refused the token
  | 'repo_unreachable'      // the token cannot open PM_GITHUB_REPO
  | 'missing_permissions'   // the token lacks one or more permissions (see `missing`)
  | 'workflow_missing'      // .github/workflows/core-update.yml is not on the default branch
  | 'merge_commits_disabled'// the repo does not allow merge commits
  | 'secret_missing'        // the PM_UPDATE_TOKEN Actions secret is not set (Finish setup fixes it)
  | 'permissions_unconfirmed' // all set, but GitHub refused or could not run a write test (see `unconfirmed`); updates still run
  | 'connected';

/** Statuses an update may start from: a write test that did not pass warns, it never blocks. */
export function canUpdate(status: ConnectionStatus | null | undefined): boolean {
  return status === 'connected' || status === 'permissions_unconfirmed';
}

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** owner/name from PM_GITHUB_REPO, when set. */
  repo: string | null;
  /** The repo's default branch, when readable. */
  defaultBranch: string | null;
  /** Token permissions that are missing, named the way GitHub's token page names them. */
  missing: string[];
  /**
   * Read and write permissions whose write test did not pass (GitHub refused
   * it, or could not run it just now). A warning: updates still run, and may
   * fail at the step that needs it.
   */
  unconfirmed: string[];
  /** One plain line on what is wrong and what to do; null when connected. */
  message: string | null;
}

export type UpdateStage =
  | 'preparing'         // the workflow is running the merge and checks
  | 'conflict'          // the merge hit files only a person can resolve
  | 'no_shared_history' // the repo was not created with the public history
  | 'checks_failed'     // merged, but type-check, core check or tests failed
  | 'ready'             // pull request open, checks passed: Apply is possible
  | 'waiting_approval'  // branch protection needs a review on GitHub first
  | 'applying'          // merge requested
  | 'applied'           // merged into the default branch; the host deploys it
  | 'failed';           // the workflow failed for another reason

export interface UpdateCheck {
  name: string;
  /** pass, fail, or still running. */
  state: 'pass' | 'fail' | 'running';
  /** For a failure: the one line that says why. */
  detail: string | null;
}

export interface UpdateRun {
  /** "1.4.0". */
  version: string;
  stage: UpdateStage;
  workflowRunUrl: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** The update branch's head commit the checks ran on; Apply merges exactly this. */
  headSha: string | null;
  /** The host's preview of the update branch (e.g. Vercel), when it posted one. */
  previewUrl: string | null;
  checks: UpdateCheck[];
  /** Files the merge could not settle, for `conflict`. */
  conflictFiles: string[];
  /** The release changes the database: the preview cannot show those parts until applied. */
  hasMigrations: boolean;
  /** For a stopped update: the workflow's one line on what went wrong, when it said. */
  message?: string | null;
  updatedAt: string;
}

import type { DatabaseUpdates } from './database';

export interface UpdatesState {
  role: InstallRole;
  /** The version this build runs. */
  current: string;
  /** Newest published release, or null when none could be read. */
  latest: ReleaseInfo | null;
  /** Releases newer than `current`, oldest first. */
  pending: ReleaseInfo[];
  /** When the release list was last read from GitHub. */
  checkedAt: string | null;
  /** Set when the release list could not be read (offline, rate limited). */
  releasesError: string | null;
  /** Null for the source install. */
  connection: ConnectionInfo | null;
  /** The newest update in progress or just finished, null when none. */
  run: UpdateRun | null;
  /** Whether deploys update the database, and what has not landed. Null when it could not be read. */
  database: DatabaseUpdates | null;
}

/**
 * The fine-grained token permissions an install's token needs, for the setup
 * steps. `checkedOnSave`: the connection check tests this access each time
 * (connection.ts, readProbes and writeProbes). Workflows cannot be: it is
 * checked when an update changes a workflow file.
 */
export const REQUIRED_TOKEN_PERMISSIONS: Array<{ name: string; access: 'Read and write' | 'Read-only'; why: string; checkedOnSave: boolean }> = [
  { name: 'Contents', access: 'Read and write', why: 'Merge the update into your code.', checkedOnSave: true },
  { name: 'Pull requests', access: 'Read and write', why: 'Open the update for review and merge it.', checkedOnSave: true },
  { name: 'Workflows', access: 'Read and write', why: 'Updates can change the files that run the checks.', checkedOnSave: false },
  { name: 'Actions', access: 'Read and write', why: 'Start the update, and read how it and the checks went.', checkedOnSave: true },
  { name: 'Secrets', access: 'Read and write', why: 'Store this token for the update workflow (Finish setup).', checkedOnSave: true },
  { name: 'Commit statuses', access: 'Read-only', why: 'Read the checks and your host\'s preview link.', checkedOnSave: true },
  { name: 'Deployments', access: 'Read-only', why: 'Find the preview of the update.', checkedOnSave: true },
  { name: 'Metadata', access: 'Read-only', why: 'Required by GitHub for every token.', checkedOnSave: true },
];

/** A release version as the routes accept it: "1.4.0" (a leading v is allowed and dropped). */
export function parseVersion(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(input.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

/** -1, 0 or 1, comparing two X.Y.Z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}
