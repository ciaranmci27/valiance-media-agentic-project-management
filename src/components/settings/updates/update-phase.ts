import { compareVersions, type ReleaseInfo, type UpdateRun, type UpdatesState } from '@/lib/updates/types';

/**
 * Settings > Updates as one of a few clearly different screens, from the
 * state GitHub reports:
 * - `current`: up to date (or the source install), a calm confirmation;
 * - `available`: a newer release is out, one call to action;
 * - `running`: an update is under way, one progress view (including the
 *   step that waits for the Owner to apply, and the deploy after it, which
 *   reads as stalled once it has taken more than 30 minutes);
 * - `failed`: an update stopped, with what failed and the one way forward.
 * The sidebar's indicator reads the same answer, so the two always agree.
 * Pure: no React, no fetch (scripts/verify-updates.ts runs it as is).
 */

export type StepKey = 'merge' | 'checks' | 'apply' | 'live';

/** done, working now, waiting on the Owner, stopped, taking far longer than it should, or still to come. */
export type StepStatus = 'done' | 'active' | 'turn' | 'failed' | 'stalled' | 'next';

export const STEP_ORDER: StepKey[] = ['merge', 'checks', 'apply', 'live'];

export const STEP_TITLES: Record<StepKey, string> = {
  merge: 'Merge the release',
  checks: 'Run the checks',
  apply: 'Review and apply',
  live: 'Go live',
};

/** How long after the merge the page keeps watching the host deploy before calling it stalled. */
export const DEPLOY_WATCH_MS = 30 * 60_000;

export interface RunProgress {
  steps: Record<StepKey, StepStatus>;
  /** The step that is happening, waiting or stopped. */
  current: StepKey;
  /** Its place, 1 to `total`. */
  number: number;
  total: number;
  /** 0 to 1, for the bar and the sidebar ring: finished steps, plus half of a step in progress. */
  fraction: number;
  /** working: nothing to do; turn: the Owner acts; failed: stopped; stalled: the deploy is taking far too long. */
  mood: 'working' | 'turn' | 'failed' | 'stalled';
}

const FAILED_STAGES = new Set<UpdateRun['stage']>(['conflict', 'no_shared_history', 'checks_failed', 'failed']);

export const isFailedRun = (run: UpdateRun) => FAILED_STAGES.has(run.stage);

/** The newest pending release (pending is oldest first). */
export function newestPending(state: UpdatesState): ReleaseInfo | null {
  return state.pending.length ? state.pending[state.pending.length - 1] : null;
}

/** A run still moving on GitHub. */
export function isRunMoving(run: UpdateRun | null): boolean {
  if (!run) return false;
  if (run.stage === 'preparing' || run.stage === 'applying') return true;
  return run.stage === 'ready' && run.checks.some((check) => check.state === 'running');
}

/**
 * The run the steps follow, or null to start fresh at Prepare. A finished run
 * for an older release than the newest one gives way to a new Prepare (each
 * release includes the ones before it); a run still moving always shows; a
 * merged run shows until this app runs its version.
 */
export function activeRun(state: UpdatesState): UpdateRun | null {
  const run = state.run;
  if (!run) return null;
  if (isRunMoving(run)) return run;
  if (run.stage === 'applied') return compareVersions(run.version, state.current) > 0 ? run : null;
  const newest = newestPending(state);
  if (newest && compareVersions(run.version, newest.version) < 0) return null;
  if (compareVersions(run.version, state.current) <= 0) return null;
  return run;
}

/** When a merged run's deploy counts as stalled (ms), or null for any other run. */
export function deployDeadline(run: UpdateRun | null): number | null {
  if (run?.stage !== 'applied') return null;
  const since = Date.parse(run.updatedAt);
  return Number.isNaN(since) ? null : since + DEPLOY_WATCH_MS;
}

/** Merged, and the host has had 30 minutes without this app running the new version. */
export function isDeployStalled(run: UpdateRun, now: number): boolean {
  const deadline = deployDeadline(run);
  return deadline !== null && now >= deadline;
}

/** Where each step stands, from the run's stage (and, once merged, how long the deploy has taken). */
export function runSteps(run: UpdateRun, now: number = Date.now()): Record<StepKey, StepStatus> {
  const checksRunning = run.checks.some((check) => check.state === 'running');
  switch (run.stage) {
    case 'preparing':
      return run.checks.length === 0
        ? { merge: 'active', checks: 'next', apply: 'next', live: 'next' }
        : { merge: 'done', checks: 'active', apply: 'next', live: 'next' };
    case 'conflict':
    case 'no_shared_history':
      return { merge: 'failed', checks: 'next', apply: 'next', live: 'next' };
    case 'failed':
      // With a pull request open the merge got through: it stopped at the checks (they never started, say).
      return run.pullRequestNumber !== null
        ? { merge: 'done', checks: 'failed', apply: 'next', live: 'next' }
        : { merge: 'failed', checks: 'next', apply: 'next', live: 'next' };
    case 'checks_failed':
      return { merge: 'done', checks: 'failed', apply: 'next', live: 'next' };
    case 'ready':
      return checksRunning
        ? { merge: 'done', checks: 'active', apply: 'next', live: 'next' }
        : { merge: 'done', checks: 'done', apply: 'turn', live: 'next' };
    case 'waiting_approval':
      return { merge: 'done', checks: 'done', apply: 'turn', live: 'next' };
    case 'applying':
      return { merge: 'done', checks: 'done', apply: 'active', live: 'next' };
    case 'applied':
      return { merge: 'done', checks: 'done', apply: 'done', live: isDeployStalled(run, now) ? 'stalled' : 'active' };
  }
}

const MOOD: Partial<Record<StepStatus, RunProgress['mood']>> = { failed: 'failed', turn: 'turn', stalled: 'stalled' };

export function runProgress(run: UpdateRun, now: number = Date.now()): RunProgress {
  const steps = runSteps(run, now);
  const current = STEP_ORDER.find((key) => steps[key] !== 'done') ?? 'live';
  const index = STEP_ORDER.indexOf(current);
  const status = steps[current];
  const done = STEP_ORDER.filter((key) => steps[key] === 'done').length;
  const half = status === 'active' || status === 'turn' || status === 'stalled' ? 0.5 : 0;
  return {
    steps,
    current,
    number: index + 1,
    total: STEP_ORDER.length,
    fraction: Math.min(1, (done + half) / STEP_ORDER.length),
    mood: MOOD[status] ?? 'working',
  };
}

export type UpdatePhase =
  | { kind: 'current' }
  | { kind: 'available'; target: ReleaseInfo; releases: ReleaseInfo[] }
  | { kind: 'running'; run: UpdateRun; progress: RunProgress; releases: ReleaseInfo[] }
  | { kind: 'failed'; run: UpdateRun; progress: RunProgress; releases: ReleaseInfo[] };

/** The releases an update to `version` brings, newest first. */
export function releasesUpTo(state: UpdatesState, version: string): ReleaseInfo[] {
  return state.pending.filter((release) => compareVersions(release.version, version) <= 0).reverse();
}

export function updatePhase(state: UpdatesState, now: number = Date.now()): UpdatePhase {
  if (state.role !== 'install') return { kind: 'current' };
  const run = activeRun(state);
  if (run) {
    const progress = runProgress(run, now);
    const releases = releasesUpTo(state, run.version);
    return isFailedRun(run) ? { kind: 'failed', run, progress, releases } : { kind: 'running', run, progress, releases };
  }
  const target = newestPending(state);
  if (target) return { kind: 'available', target, releases: [...state.pending].reverse() };
  return { kind: 'current' };
}

/** What the sidebar shows beside Settings, and the line its tooltip reads. */
export interface UpdateSignal {
  tone: 'working' | 'turn' | 'failed' | 'stalled' | 'available';
  label: string;
  /** For an update under way: how far along, for the ring. */
  fraction: number | null;
}

export function updateSignal(state: UpdatesState | undefined, now: number = Date.now()): UpdateSignal | null {
  if (!state) return null;
  const phase = updatePhase(state, now);
  switch (phase.kind) {
    case 'current':
      return null;
    case 'available':
      return { tone: 'available', label: `${phase.target.version} is ready to install`, fraction: null };
    case 'failed':
      return { tone: 'failed', label: `Update to ${phase.run.version} stopped at step ${phase.progress.number} of ${phase.progress.total}`, fraction: phase.progress.fraction };
    case 'running': {
      const { progress, run } = phase;
      const step = `step ${progress.number} of ${progress.total}`;
      if (progress.mood === 'stalled') {
        return { tone: 'stalled', label: `Deploy taking long: ${run.version} isn't live yet`, fraction: progress.fraction };
      }
      if (progress.mood === 'turn') {
        return {
          tone: 'turn',
          label: run.stage === 'waiting_approval'
            ? `Update to ${run.version} needs an approval on GitHub, ${step}`
            : `Update to ${run.version} is ready to apply, ${step}`,
          fraction: progress.fraction,
        };
      }
      return { tone: 'working', label: `Updating to ${run.version}, ${step}`, fraction: progress.fraction };
    }
  }
}

/**
 * A run worth asking about again: still moving on GitHub, or merged and
 * deploying, until this app runs its version or the deploy counts as stalled
 * (then only Check now asks).
 */
export function shouldPoll(state: UpdatesState | undefined, now: number = Date.now()): boolean {
  const run = state?.run;
  if (!state || !run) return false;
  if (isRunMoving(run)) return true;
  if (run.stage === 'applied') return compareVersions(run.version, state.current) > 0 && !isDeployStalled(run, now);
  return false;
}

/* Release notes: sections, and what a person should read before updating. */

export interface NotesSection {
  title: string | null;
  body: string;
}

/** Splits at ## and ### headings, dropping a heading that only repeats the version. */
export function splitNotes(markdown: string, version: string): NotesSection[] {
  const sections: NotesSection[] = [];
  let current: NotesSection = { title: null, body: '' };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      current.body += `${line}\n`;
      continue;
    }
    const title = heading[1];
    // "## [1.5.0] - 2026-11-20" names the release the card already names.
    if (!line.startsWith('###') && title.includes(version)) continue;
    if (current.title || current.body.trim()) sections.push(current);
    current = { title, body: '' };
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections.filter((section) => section.body.trim());
}

export interface NotesCallout {
  version: string;
  body: string;
}

export interface NotesDigest {
  /** Each release's Breaking section, newest first. */
  breaking: NotesCallout[];
  /** Each release's Database section, newest first. */
  database: NotesCallout[];
  /** Bullet points across every section, for "12 changes". */
  changes: number;
}

/** The Breaking and Database sections, and how many changes, across releases (newest first). */
export function digestNotes(releases: ReleaseInfo[]): NotesDigest {
  const digest: NotesDigest = { breaking: [], database: [], changes: 0 };
  for (const release of releases) {
    for (const section of splitNotes(release.notes, release.version)) {
      const items = section.body.split('\n').filter((line) => /^\s{0,3}[-*]\s+\S/.test(line)).length;
      digest.changes += items || 1;
      if (section.title && /^breaking/i.test(section.title)) digest.breaking.push({ version: release.version, body: section.body.trim() });
      else if (section.title && /^database/i.test(section.title)) digest.database.push({ version: release.version, body: section.body.trim() });
    }
  }
  return digest;
}
