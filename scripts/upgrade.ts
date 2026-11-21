/**
 * Update this install to a newer release by merging its tag from the public
 * repo. Never pushes: review the merge, then push or open a pull request.
 *
 *   npm run upgrade                          merge the latest release above this version
 *   npm run upgrade -- --to v1.4.0           merge a specific release
 *   npm run upgrade -- --branch update/v1.4.0   merge on a new branch
 *   npm run upgrade -- --json summary.json   also write a JSON summary (for CI and the app)
 *   npm run upgrade -- --skip-checks         skip install, type-check, check:core and tests
 *   npm run upgrade -- --upstream <url>      fetch releases from another URL (a mirror, or a test repo)
 *
 * How a merge resolves: package.json and vercel.json merge as JSON (the
 * install's dependencies, scripts and crons survive; the release wins a real
 * disagreement); package-lock.json takes the release's copy and is regenerated.
 * A conflict in any other file means an install edited a core file: the merge
 * is aborted, the repo is left exactly as it was, and the files are listed.
 *
 * Exit codes: 0 updated or already up to date, 1 error, 2 conflicts (merge
 * aborted), 3 no shared history with the public repo, 4 merged but a check failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSourceMonorepo } from './lib/core-paths';
import { compareSemver, git, gitRun, lines, parseSemver, releaseTags } from './lib/git';
import { mergeJsonText, type MergeFile, type MergeNote } from './lib/json-merge';
import { byName } from './lib/migrations';
import { UPSTREAM_REPO, UPSTREAM_URL } from '../src/lib/updates/config';

export interface UpgradeOptions {
  root: string;
  to?: string;
  branch?: string;
  json?: string;
  skipChecks?: boolean;
  upstreamUrl?: string;
  log?: (line: string) => void;
}

export interface CheckResult {
  name: string;
  command: string;
  /** null when skipped. */
  ok: boolean | null;
  exitCode: number | null;
  durationMs: number;
  /** The last part of the command's output. */
  output: string;
}

export interface AutoResolved {
  file: string;
  how: 'json-merge' | 'release-copy-regenerated';
  /** Values where both sides disagreed, and which side the merge kept. */
  notes: MergeNote[];
}

export interface UpgradeSummary {
  from: string;
  to: string | null;
  merged: boolean;
  upToDate: boolean;
  branch: string | null;
  commit: string | null;
  /** Files that could not be merged automatically (the merge was aborted). */
  conflicts: string[];
  autoResolved: AutoResolved[];
  checks: CheckResult[];
  /** Core migration files the release adds (npm run db:migrate applies them). */
  migrationsInRelease: string[];
  message: string;
  exitCode: number;
}

const JSON_FILES: MergeFile[] = ['package.json', 'vercel.json'];
const LOCKFILE = 'package-lock.json';

class UpgradeStop extends Error {
  constructor(public exitCode: number, message: string) {
    super(message);
  }
}

function readVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** github.com/owner/name for https and ssh forms; an absolute path for local folders. */
export function normalizeRemote(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  const web = trimmed.match(/^(?:https?|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (web) return `${web[1]}/${web[2]}`.toLowerCase();
  return resolve(trimmed).replace(/\\/g, '/').toLowerCase();
}

/** Shell commands are fixed strings (no user input); a shell finds npm and npx on Windows. */
function runCommand(root: string, command: string): { code: number; output: string; durationMs: number } {
  const started = Date.now();
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { code: result.status ?? 1, output, durationMs: Date.now() - started };
}

const tail = (text: string) => (text.length > 4000 ? `...${text.slice(-4000)}` : text);

function hasScript(root: string, name: string): boolean {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return Boolean(pkg.scripts?.[name]);
}

function showStage(root: string, stage: 1 | 2 | 3, path: string): string | null {
  const result = gitRun(root, ['show', `:${stage}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}

function showAt(root: string, ref: string, path: string): string | null {
  const result = gitRun(root, ['show', `${ref}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function upgrade(options: UpgradeOptions): UpgradeSummary {
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const summary: UpgradeSummary = {
    from: '', to: null, merged: false, upToDate: false, branch: null, commit: null,
    conflicts: [], autoResolved: [], checks: [], migrationsInRelease: [], message: '', exitCode: 0,
  };

  let createdBranch: string | null = null;
  let originalRef: string | null = null;
  // Only a merge this run started is ever aborted: a merge the user already had open is theirs.
  let mergeStarted = false;
  const undoBranch = () => {
    if (!createdBranch || !originalRef) return;
    gitRun(root, ['checkout', '--quiet', originalRef]);
    gitRun(root, ['branch', '-D', createdBranch]);
    createdBranch = null;
    summary.branch = null;
  };
  const abortMerge = () => {
    if (mergeStarted && gitRun(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0) gitRun(root, ['merge', '--abort']);
    undoBranch();
  };

  try {
    if (!existsSync(resolve(root, 'package.json'))) throw new UpgradeStop(1, 'Run the upgrade from the app folder (package.json not found).');
    summary.from = readVersion(root);
    if (isSourceMonorepo(root)) {
      summary.message = 'This is the source install (the monorepo releases are cut from); it does not take upgrades. Nothing to do.';
      return summary;
    }
    if (gitRun(root, ['rev-parse', '--show-prefix']).stdout.trim() !== '') {
      throw new UpgradeStop(1, 'The app must be the top level of its git repository to take release merges.');
    }
    if (gitRun(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0) {
      throw new UpgradeStop(1, 'A merge is already in progress. Finish it or run git merge --abort, then try again.');
    }
    const dirty = lines(git(root, ['status', '--porcelain', '--untracked-files=normal']));
    if (dirty.length) {
      throw new UpgradeStop(1, `The working tree has uncommitted changes (${dirty.length} file(s)). Commit or stash them first.`);
    }

    // The upstream remote.
    const url = options.upstreamUrl ?? UPSTREAM_URL;
    const existing = gitRun(root, ['remote', 'get-url', 'upstream']);
    if (existing.code !== 0) {
      git(root, ['remote', 'add', 'upstream', url]);
      log(`Added remote upstream: ${url}`);
    } else if (normalizeRemote(existing.stdout) !== normalizeRemote(url)) {
      if (options.upstreamUrl) {
        git(root, ['remote', 'set-url', 'upstream', url]);
        log(`Pointed remote upstream at ${url}`);
      } else {
        throw new UpgradeStop(1, `Remote upstream points at ${existing.stdout.trim()}, not ${url}. Fix it with: git remote set-url upstream ${url} (or pass --upstream <url>).`);
      }
    }
    log('Fetching release tags...');
    git(root, ['fetch', '--quiet', '--no-recurse-submodules', '--tags', 'upstream']);

    // The target release.
    const tags = releaseTags(root);
    const current = parseSemver(summary.from);
    let target: string | undefined;
    if (options.to) {
      target = options.to.startsWith('v') ? options.to : `v${options.to}`;
      if (!parseSemver(target)) throw new UpgradeStop(1, `--to ${options.to} is not a release version (vX.Y.Z).`);
      if (!tags.includes(target)) throw new UpgradeStop(1, `Release ${target} was not found upstream. Latest: ${tags[0] ?? 'none'}.`);
      if (current && compareSemver(parseSemver(target)!, current) < 0) {
        throw new UpgradeStop(1, `${target} is older than this install (v${summary.from}); upgrades only move forward.`);
      }
    } else {
      target = tags.find(tag => !current || compareSemver(parseSemver(tag)!, current) > 0);
    }
    if (!target || gitRun(root, ['merge-base', '--is-ancestor', target, 'HEAD']).code === 0) {
      summary.upToDate = true;
      summary.to = target ? target.slice(1) : null;
      summary.message = `Already up to date at v${summary.from}.`;
      return summary;
    }
    summary.to = target.slice(1);

    const mergeBase = gitRun(root, ['merge-base', 'HEAD', target]);
    if (mergeBase.code !== 0) {
      throw new UpgradeStop(3, [
        `${target} shares no history with this repository, so it cannot be merged.`,
        'An install must be a copy of the public repo with its full history. To fix it:',
        `  1. git clone https://github.com/${UPSTREAM_REPO}.git <new-folder>`,
        `  2. In it: git checkout -B main ${target}, then copy in your client-owned files (src/custom, supabase/migrations/custom, public/custom, your own .claude skills, agents, commands and settings.local.json, .github/workflows/custom-*.yml) and re-apply your package.json and vercel.json changes.`,
        '  3. git remote rename origin upstream, git remote add origin <your repo URL>, then commit and push.',
      ].join('\n'));
    }

    // Core migrations the release adds, from the release this install runs (or the shared ancestor).
    const fromTag = `v${summary.from}`;
    const fromRef = tags.includes(fromTag) && gitRun(root, ['merge-base', '--is-ancestor', fromTag, 'HEAD']).code === 0 ? fromTag : mergeBase.stdout.trim();
    summary.migrationsInRelease = lines(git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=A', fromRef, target, '--', 'supabase/migrations']))
      .filter(path => /^supabase\/migrations\/[^/]+\.sql$/.test(path))
      .map(path => path.slice('supabase/migrations/'.length))
      .sort(byName);

    if (options.branch) {
      if (gitRun(root, ['rev-parse', '-q', '--verify', `refs/heads/${options.branch}`]).code === 0) {
        throw new UpgradeStop(1, `Branch ${options.branch} already exists. Pick another name or delete it first.`);
      }
      originalRef = gitRun(root, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim() || git(root, ['rev-parse', 'HEAD']);
      git(root, ['checkout', '--quiet', '-b', options.branch]);
      createdBranch = options.branch;
      summary.branch = options.branch;
    } else {
      summary.branch = gitRun(root, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim() || null;
    }

    log(`Merging ${target} into ${summary.branch ?? 'HEAD'}...`);
    // --no-commit: resolve and validate first, then make one merge commit.
    mergeStarted = true;
    const merge = gitRun(root, ['merge', '--no-ff', '--no-commit', target]);
    if (gitRun(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0) {
      undoBranch();
      throw new UpgradeStop(1, `git merge ${target} failed: ${(merge.stderr || merge.stdout).trim()}`);
    }

    const unmerged = lines(git(root, ['diff', '--name-only', '--diff-filter=U']));
    const stagesPresent = (path: string) => showStage(root, 2, path) !== null && showStage(root, 3, path) !== null;
    const blocking = unmerged.filter(path =>
      !((JSON_FILES as string[]).includes(path) || path === LOCKFILE) || !stagesPresent(path));
    if (blocking.length) {
      abortMerge();
      summary.conflicts = blocking;
      throw new UpgradeStop(2, [
        `${target} conflicts with changes this install made to core files, so the merge was aborted and nothing changed:`,
        ...blocking.map(path => `  ${path}`),
        'Move those changes into src/custom (or propose them upstream), then run the upgrade again.',
      ].join('\n'));
    }

    // package.json and vercel.json: a JSON merge when git conflicted, or when its text merge is not valid JSON.
    for (const file of JSON_FILES) {
      let merged: { text: string; notes: MergeNote[] } | null = null;
      if (unmerged.includes(file)) {
        merged = mergeJsonText(file, showStage(root, 1, file), showStage(root, 2, file)!, showStage(root, 3, file)!);
      } else if (existsSync(resolve(root, file)) && !isValidJson(readFileSync(resolve(root, file), 'utf8'))) {
        const ours = showAt(root, 'HEAD', file);
        const theirs = showAt(root, target, file);
        if (ours === null || theirs === null) throw new Error(`${file} is not valid JSON after the merge`);
        merged = mergeJsonText(file, showAt(root, mergeBase.stdout.trim(), file), ours, theirs);
      }
      if (!merged) continue;
      writeFileSync(resolve(root, file), merged.text);
      git(root, ['add', '--', file]);
      summary.autoResolved.push({ file, how: 'json-merge', notes: merged.notes });
      for (const note of merged.notes) log(`  ${file} ${note.path}: ${note.reason}`);
    }

    if (unmerged.includes(LOCKFILE)) {
      git(root, ['checkout', '--theirs', '--', LOCKFILE]);
      log('Regenerating package-lock.json from the merged package.json...');
      const npm = runCommand(root, 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund');
      if (npm.code !== 0) {
        abortMerge();
        throw new UpgradeStop(1, `Could not regenerate package-lock.json, so the merge was aborted:\n${tail(npm.output)}`);
      }
      git(root, ['add', '--', LOCKFILE]);
      summary.autoResolved.push({ file: LOCKFILE, how: 'release-copy-regenerated', notes: [] });
    }

    const commit = gitRun(root, ['commit', '--quiet', '-m', `Update to ${target}`]);
    if (commit.code !== 0) {
      abortMerge();
      throw new UpgradeStop(1, `The merge commit failed, so the merge was aborted:\n${(commit.stderr || commit.stdout).trim()}`);
    }
    summary.merged = true;
    summary.commit = git(root, ['rev-parse', 'HEAD']);
    log(`Merged ${target} (${summary.commit.slice(0, 12)}).`);

    if (!options.skipChecks) {
      summary.checks = runChecks(root, log);
      if (lines(git(root, ['status', '--porcelain', '--', LOCKFILE])).length) {
        git(root, ['commit', '--quiet', '-m', `Update lockfile for ${target}`, '--', LOCKFILE]);
        summary.commit = git(root, ['rev-parse', 'HEAD']);
      }
    }
    const failed = summary.checks.filter(check => check.ok === false);
    summary.exitCode = failed.length ? 4 : 0;
    summary.message = failed.length
      ? `Merged ${target}, but ${failed.map(check => check.name).join(', ')} failed. Fix it on this branch before shipping.`
      : `Updated to ${target}.${summary.migrationsInRelease.length ? ` Run npm run db:migrate for ${summary.migrationsInRelease.length} new migration(s).` : ''} Review, then push.`;
    return summary;
  } catch (err) {
    // Until the merge commit exists, any failure leaves the repo exactly as it was:
    // this run's merge aborted, back on the original branch, the new branch removed.
    if (!summary.merged) abortMerge();
    if (err instanceof UpgradeStop) {
      summary.exitCode = err.exitCode;
      summary.message = err.message;
    } else {
      summary.exitCode = 1;
      summary.message = err instanceof Error ? err.message : String(err);
    }
    return summary;
  } finally {
    if (options.json) writeFileSync(resolve(options.json), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

function runChecks(root: string, log: (line: string) => void): CheckResult[] {
  const steps: { name: string; command: string; script?: string }[] = [
    { name: 'install', command: 'npm install --no-audit --no-fund' },
    { name: 'type-check', command: 'npx tsc --noEmit' },
    { name: 'check:core', command: 'npm run -s check:core', script: 'check:core' },
    { name: 'tests', command: 'npm run -s test:core', script: 'test:core' },
  ];
  const results: CheckResult[] = [];
  let installFailed = false;
  for (const step of steps) {
    if (installFailed || (step.script && !hasScript(root, step.script))) {
      const why = installFailed ? 'skipped: npm install failed' : `skipped: no ${step.script} script`;
      results.push({ name: step.name, command: step.command, ok: null, exitCode: null, durationMs: 0, output: why });
      log(`  ${step.name}: ${why}`);
      continue;
    }
    log(`  ${step.name}: ${step.command}`);
    const run = runCommand(root, step.command);
    const ok = run.code === 0;
    results.push({ name: step.name, command: step.command, ok, exitCode: run.code, durationMs: run.durationMs, output: tail(run.output) });
    log(`  ${step.name}: ${ok ? 'passed' : `FAILED (exit ${run.code})`}`);
    if (!ok && step.name === 'install') installFailed = true;
  }
  return results;
}

export function parseArgs(argv: string[]): Omit<UpgradeOptions, 'root' | 'log'> {
  const options: Omit<UpgradeOptions, 'root' | 'log'> = {};
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--to') options.to = value(i++, arg);
    else if (arg === '--branch') options.branch = value(i++, arg);
    else if (arg === '--json') options.json = value(i++, arg);
    else if (arg === '--upstream') options.upstreamUrl = value(i++, arg);
    else if (arg === '--skip-checks') options.skipChecks = true;
    else throw new Error(`Unknown option ${arg}. Options: --to vX.Y.Z --branch <name> --json <file> --skip-checks --upstream <url>`);
  }
  return options;
}

if (require.main === module) {
  let code = 1;
  try {
    const summary = upgrade({ root: process.cwd(), ...parseArgs(process.argv.slice(2)), log: line => console.log(line) });
    (summary.exitCode === 0 ? console.log : console.error)(summary.message);
    code = summary.exitCode;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(code);
}
