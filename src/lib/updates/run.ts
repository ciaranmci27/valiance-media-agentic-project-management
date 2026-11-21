/**
 * An update's progress, derived from GitHub on every read: the core-update
 * workflow run named "Update to v<version>", the result line its log ends
 * with, the pull request from update/<version> into the default branch, and
 * the workflow runs and commit statuses on that pull request's head commit.
 * Nothing is stored in the app.
 *
 * Only what a fine-grained token can read: Actions (runs, jobs, job logs),
 * Pull requests, Commit statuses and Deployments. Fine-grained tokens have no
 * Checks permission, so check runs and annotations are never read.
 */
import { refPath, UPDATE_WORKFLOW_FILE } from './connection';
import { GitHubError, repoPath, safeUrl, type GitHubClient } from './github';
import type { ReleaseInfo, UpdateCheck, UpdateRun, UpdateStage } from './types';

/** The checks workflow whose success on the head commit Apply requires. */
export const CHECKS_WORKFLOW_PATH = '.github/workflows/core-checks.yml';

/** The line core-update.yml's log ends with when it stops: `PM_UPDATE_RESULT {json}`. */
export const RESULT_MARKER = 'PM_UPDATE_RESULT';

/** How long after the workflow finishes its pull request, and then core-checks.yml, may take to show up. */
export const CHECKS_GRACE_MS = 3 * 60 * 1000;

/** core-checks.yml never started on the update: the page stops polling and says what to check. */
export const CHECKS_NEVER_RAN_MESSAGE = `The checks never started on the update. Check that GitHub Actions is enabled for the repository, and that ${CHECKS_WORKFLOW_PATH} is on the update branch and enabled in the Actions tab, then prepare again.`;

export const updateBranch = (version: string) => `update/${version}`;
export const runTitle = (version: string) => `Update to v${version}`;

interface RawRun {
  id: number;
  name?: string;
  path?: string;
  workflow_id?: number;
  display_title?: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface RawJob {
  id: number;
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  steps?: Array<{ name?: string; status?: string | null; conclusion?: string | null }>;
}

interface RawPull {
  number: number;
  state?: string;
  merged_at?: string | null;
  html_url?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  mergeable_state?: string;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
}

interface RawStatus {
  context?: string;
  state?: string;
  description?: string | null;
  target_url?: string | null;
}

interface RawDeployment {
  id: number;
  environment?: string;
  production_environment?: boolean;
  transient_environment?: boolean;
}

interface RawDeploymentStatus {
  state?: string;
  environment_url?: string | null;
  target_url?: string | null;
}

const time = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(value) ? 0 : value;
};

const firstLine = (text: string | null | undefined): string | null => {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 300) : null;
};

/** The summary core-update.yml hides in the pull request body. */
export function parseHiddenSummary(body: string | null | undefined): { migrationsInRelease?: string[]; hasMigrations?: boolean } | null {
  const match = /<!--\s*pm-update-summary\s+(\{[\s\S]*?\})\s*-->/.exec(body ?? '');
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as { migrationsInRelease?: string[]; hasMigrations?: boolean } : null;
  } catch {
    return null;
  }
}

export interface UpdateResult {
  kind: 'conflict' | 'no_shared_history' | 'checks_failed' | 'failed';
  files: string[];
  checks: Array<{ name: string; detail: string | null }>;
  message: string | null;
}

const RESULT_KINDS = new Set<UpdateResult['kind']>(['conflict', 'no_shared_history', 'checks_failed', 'failed']);
const clean = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The last `PM_UPDATE_RESULT {json}` line in a job log (GitHub prefixes each
 * line with a timestamp), checked field by field. Null when there is none.
 */
export function parseResultMarker(log: string): UpdateResult | null {
  const lines = log.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(`${RESULT_MARKER} {`);
    if (at < 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i].slice(at + RESULT_MARKER.length + 1).trim());
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as { kind?: unknown; files?: unknown; checks?: unknown; message?: unknown };
    if (typeof value.kind !== 'string' || !RESULT_KINDS.has(value.kind as UpdateResult['kind'])) continue;
    const files = Array.isArray(value.files)
      ? value.files.map((file) => clean(file, 500)).filter((file): file is string => file !== null).slice(0, 200)
      : [];
    const checks = Array.isArray(value.checks)
      ? value.checks.flatMap((check) => {
        if (!check || typeof check !== 'object') return [];
        const name = clean((check as { name?: unknown }).name, 120);
        return name ? [{ name, detail: firstLine(clean((check as { detail?: unknown }).detail, 2000)) }] : [];
      }).slice(0, 20)
      : [];
    return { kind: value.kind as UpdateResult['kind'], files, checks, message: firstLine(clean(value.message, 2000)) };
  }
  return null;
}

/** pass, fail or running, from a workflow run or job's status and conclusion. */
function stateOf(item: { status?: string | null; conclusion?: string | null }): UpdateCheck['state'] {
  if (item.status !== 'completed') return 'running';
  return ['success', 'neutral', 'skipped'].includes(item.conclusion ?? '') ? 'pass' : 'fail';
}

function checkFromStatus(status: RawStatus): UpdateCheck {
  const name = status.context || 'Status';
  if (status.state === 'success') return { name, state: 'pass', detail: null };
  if (status.state === 'pending') return { name, state: 'running', detail: null };
  return { name, state: 'fail', detail: firstLine(status.description) };
}

async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitHubError && (error.kind === 'not_found' || error.kind === 'forbidden')) return fallback;
    throw error;
  }
}

async function jobsOf(gh: GitHubClient, repo: string, runId: number): Promise<RawJob[]> {
  return optional(async () => (await gh.request<{ jobs?: RawJob[] }>(repoPath(repo, `/actions/runs/${runId}/jobs?per_page=30`))).data?.jobs ?? [], [] as RawJob[]);
}

/** Why core-update stopped, from the result line at the end of its failed job's log. */
async function runFailure(gh: GitHubClient, repo: string, runId: number): Promise<Pick<UpdateRun, 'stage' | 'conflictFiles' | 'checks' | 'message'>> {
  const jobs = await jobsOf(gh, repo, runId);
  const failed = jobs.filter((job) => job.conclusion === 'failure');
  let result: UpdateResult | null = null;
  for (const job of (failed.length ? failed : jobs).slice(0, 3)) {
    try {
      result = parseResultMarker(await gh.download(repoPath(repo, `/actions/jobs/${job.id}/logs`)));
    } catch {
      result = null;
    }
    if (result) break;
  }
  if (!result) {
    const step = failed.flatMap((job) => job.steps ?? []).find((item) => item.conclusion === 'failure');
    return { stage: 'failed', conflictFiles: [], checks: [], message: step?.name ? `Stopped at: ${step.name}` : null };
  }
  const stage: UpdateStage = result.kind;
  return {
    stage,
    conflictFiles: stage === 'conflict' ? result.files : [],
    checks: stage === 'checks_failed' ? result.checks.map((check) => ({ name: check.name, state: 'fail' as const, detail: check.detail })) : [],
    message: result.message,
  };
}

type CoreChecks = 'missing' | 'running' | 'passed' | 'failed';

const ended = (conclusion: string | null | undefined) => (conclusion ? `Ended: ${conclusion.replace(/_/g, ' ')}` : null);

/**
 * The checks on a commit: each workflow run's jobs (newest run per workflow)
 * and each commit status (newest per context), plus where core-checks.yml stands.
 */
async function commitChecks(gh: GitHubClient, repo: string, sha: string): Promise<{ checks: UpdateCheck[]; statuses: RawStatus[]; core: CoreChecks }> {
  const [runs, combined] = await Promise.all([
    optional(async () => (await gh.request<{ workflow_runs?: RawRun[] }>(repoPath(repo, `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`))).data?.workflow_runs ?? [], [] as RawRun[]),
    optional(async () => (await gh.request<{ statuses?: RawStatus[] }>(repoPath(repo, `/commits/${refPath(sha)}/status?per_page=100`))).data?.statuses ?? [], [] as RawStatus[]),
  ]);
  const latest = new Map<string, RawRun>();
  for (const run of runs) {
    const key = String(run.workflow_id ?? run.path ?? run.name ?? run.id);
    const seen = latest.get(key);
    if (!seen || time(run.created_at) > time(seen.created_at) || (time(run.created_at) === time(seen.created_at) && run.id > seen.id)) latest.set(key, run);
  }
  const newest = [...latest.values()].slice(0, 10);
  // A run that passed reads as one check; only a running or failed run's jobs are read (for which step).
  const perRun = await Promise.all(newest.map(async (run) => ({ run, jobs: stateOf(run) === 'pass' ? [] : await jobsOf(gh, repo, run.id) })));
  const checks: UpdateCheck[] = [];
  for (const { run, jobs } of perRun) {
    const runName = run.name || 'Workflow';
    if (!jobs.length) {
      const state = stateOf(run);
      checks.push({ name: runName, state, detail: state === 'fail' ? ended(run.conclusion) : null });
      continue;
    }
    for (const job of jobs) {
      const state = stateOf(job);
      const step = state === 'fail' ? (job.steps ?? []).find((item) => item.conclusion === 'failure') : undefined;
      checks.push({
        name: jobs.length === 1 ? runName : `${runName} / ${job.name || 'job'}`,
        state,
        detail: state === 'fail' ? (step?.name ? `Failed at: ${step.name}` : ended(job.conclusion)) : null,
      });
    }
  }
  for (const status of statuses(combined)) checks.push(checkFromStatus(status));

  const coreRun = newest.find((run) => (run.path ?? '').split('@')[0] === CHECKS_WORKFLOW_PATH);
  const core: CoreChecks = !coreRun ? 'missing'
    : coreRun.status !== 'completed' ? 'running'
      : coreRun.conclusion === 'success' ? 'passed' : 'failed';
  return { checks, statuses: combined, core };
}

const statuses = (list: RawStatus[]) => {
  const seen = new Set<string>();
  return list.filter((status) => {
    const key = status.context || '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The host's preview of a commit: a non-production deployment that succeeded, else a preview status link. */
async function previewFor(gh: GitHubClient, repo: string, sha: string, commitStatuses: RawStatus[]): Promise<string | null> {
  const deployments = await optional(async () => (await gh.request<RawDeployment[]>(repoPath(repo, `/deployments?sha=${encodeURIComponent(sha)}&per_page=10`))).data ?? [], [] as RawDeployment[]);
  // The newest non-production deployment only: one more read, not one per deployment.
  const deployment = deployments.find((item) => item.production_environment !== true && !/^production$/i.test(item.environment ?? ''));
  if (deployment) {
    const list = await optional(async () => (await gh.request<RawDeploymentStatus[]>(repoPath(repo, `/deployments/${deployment.id}/statuses?per_page=10`))).data ?? [], [] as RawDeploymentStatus[]);
    const success = list.find((status) => status.state === 'success');
    const url = safeUrl(success?.environment_url) ?? safeUrl(success?.target_url);
    if (url) return url;
  }
  const preview = commitStatuses.find((status) => status.state === 'success' && /preview/i.test(`${status.context ?? ''} ${status.description ?? ''}`));
  return safeUrl(preview?.target_url);
}

export interface DeriveRunOptions {
  /** The repo's default branch: only a pull request into it counts. */
  defaultBranch: string;
  /** The release, for hasMigrations when the pull request carries no summary. */
  release?: ReleaseInfo | null;
  now?: () => Date;
}

/** The newest workflow run for a version, newest first by creation. */
async function latestRun(gh: GitHubClient, repo: string, titles: Set<string>): Promise<RawRun | null> {
  const runs = await optional(async () => (await gh.request<{ workflow_runs?: RawRun[] }>(
    repoPath(repo, `/actions/workflows/${UPDATE_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50`),
  )).data?.workflow_runs ?? [], [] as RawRun[]);
  return runs
    .filter((run) => titles.has(run.display_title ?? ''))
    .sort((a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id)[0] ?? null;
}

/**
 * Which pending version the run follows: the one whose workflow ran most
 * recently, else the newest pending release.
 */
export async function versionToFollow(gh: GitHubClient, repo: string, pending: ReleaseInfo[]): Promise<string | null> {
  if (!pending.length) return null;
  const byTitle = new Map(pending.map((release) => [runTitle(release.version), release.version]));
  const run = await latestRun(gh, repo, new Set(byTitle.keys()));
  return (run && byTitle.get(run.display_title ?? '')) || pending[pending.length - 1].version;
}

/** The update's state for one version, or null when nothing was started for it. */
export async function deriveRun(gh: GitHubClient, repo: string, version: string, options: DeriveRunOptions): Promise<UpdateRun | null> {
  const now = (options.now ?? (() => new Date()))();
  const owner = repo.split('/')[0];
  const [run, pulls] = await Promise.all([
    latestRun(gh, repo, new Set([runTitle(version)])),
    optional(async () => (await gh.request<RawPull[]>(
      repoPath(repo, `/pulls?state=all&head=${encodeURIComponent(`${owner}:${updateBranch(version)}`)}&per_page=10`),
    )).data ?? [], [] as RawPull[]),
  ]);
  const pull = pulls
    // Only this repo's own update branch, never a fork's branch of the same
    // name, and only into the default branch the host deploys.
    .filter((item) => item.head?.ref === updateBranch(version)
      && item.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()
      && item.base?.ref === options.defaultBranch)
    .sort((a, b) => time(b.created_at) - time(a.created_at) || b.number - a.number)[0] ?? null;
  if (!run && !pull) return null;

  const result: UpdateRun = {
    version,
    stage: 'preparing',
    workflowRunUrl: safeUrl(run?.html_url),
    pullRequestUrl: pull ? safeUrl(pull.html_url) : null,
    pullRequestNumber: pull ? pull.number : null,
    headSha: pull?.head?.sha && /^[0-9a-f]{40}$/i.test(pull.head.sha) ? pull.head.sha : null,
    previewUrl: null,
    checks: [],
    conflictFiles: [],
    hasMigrations: options.release?.hasMigrations ?? false,
    updatedAt: new Date(Math.max(time(run?.updated_at), time(pull?.updated_at)) || now.getTime()).toISOString(),
  };
  const summary = parseHiddenSummary(pull?.body);
  if (summary) {
    result.hasMigrations = result.hasMigrations
      || summary.hasMigrations === true
      || (Array.isArray(summary.migrationsInRelease) && summary.migrationsInRelease.length > 0);
  }

  // Merged: the code is in, whatever ran after.
  if (pull?.merged_at) return { ...result, stage: 'applied' };

  // The workflow is still merging and checking.
  if (run && run.status !== 'completed') return { ...result, stage: 'preparing' };

  const openPull = pull && pull.state === 'open' ? pull : null;
  const runFailed = run && run.status === 'completed' && run.conclusion !== 'success';
  // A failed run newer than the open pull request is the latest word.
  if (runFailed && (!openPull || time(run.created_at) > time(openPull.created_at))) {
    return { ...result, ...(await runFailure(gh, repo, run.id)) };
  }

  if (!openPull) {
    // Closed without merging: start again from Prepare.
    if (pull) return null;
    // The run pushed and is opening the pull request, or it vanished.
    return { ...result, stage: run && now.getTime() - time(run.updated_at) < CHECKS_GRACE_MS ? 'preparing' : 'failed' };
  }

  const [detail, commit] = await Promise.all([
    gh.request<RawPull>(repoPath(repo, `/pulls/${openPull.number}`)).then((response) => response.data),
    result.headSha ? commitChecks(gh, repo, result.headSha) : Promise.resolve(null),
  ]);
  const headSha = detail?.head?.sha && /^[0-9a-f]{40}$/i.test(detail.head.sha) ? detail.head.sha : result.headSha;
  const onHead = headSha === result.headSha ? commit : headSha ? await commitChecks(gh, repo, headSha) : null;
  const checks = onHead?.checks ?? [];
  const previewUrl = headSha ? await previewFor(gh, repo, headSha, onHead?.statuses ?? []) : null;
  const next: UpdateRun = { ...result, headSha, checks, previewUrl };

  if (checks.some((check) => check.state === 'fail') || onHead?.core === 'failed') return { ...next, stage: 'checks_failed' };
  if (detail?.mergeable_state === 'dirty') return { ...next, stage: 'conflict' };
  // core-checks.yml never started (Actions off, the workflow off or missing on
  // this commit): after the grace period, stop as failed so polling ends.
  if (onHead?.core === 'missing') {
    const since = Math.max(time(openPull.created_at), time(run?.updated_at));
    if (now.getTime() - since >= CHECKS_GRACE_MS) return { ...next, stage: 'failed', message: CHECKS_NEVER_RAN_MESSAGE };
  }
  // Ready needs core-checks.yml to have run on this exact commit and passed,
  // with nothing else still running. Until then the update is still preparing.
  if (onHead?.core !== 'passed' || checks.some((check) => check.state === 'running')) return { ...next, stage: 'preparing' };
  if (detail?.mergeable_state === 'blocked') return { ...next, stage: 'waiting_approval' };
  return { ...next, stage: 'ready' };
}

/** Apply merges only a ready update with at least one check seen and every check passed. */
export function canApply(run: UpdateRun | null): run is UpdateRun & { headSha: string; pullRequestNumber: number } {
  return !!run && run.stage === 'ready' && !!run.headSha && run.pullRequestNumber !== null
    && run.checks.length > 0 && run.checks.every((check) => check.state === 'pass');
}
