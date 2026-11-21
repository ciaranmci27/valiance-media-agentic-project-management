/**
 * Small git helpers for the release tooling (upgrade, check:core). Every call
 * runs git directly (no shell) in the given folder.
 */
import { spawnSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git; returns the result whatever the exit code. Paths come back unquoted. */
export function gitRun(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Runs git and returns trimmed stdout; throws with git's own message on failure. */
export function git(cwd: string, args: string[]): string {
  const result = gitRun(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** X.Y.Z or vX.Y.Z; prereleases and anything else are not releases. */
export function parseSemver(text: string): Semver | null {
  const match = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Release tags (vX.Y.Z) matching the git args' selection, highest first. */
export function releaseTags(cwd: string, extra: string[] = []): string[] {
  return lines(git(cwd, ['tag', '-l', 'v*', ...extra]))
    .filter(tag => parseSemver(tag))
    .sort((a, b) => compareSemver(parseSemver(b)!, parseSemver(a)!));
}

/** Paths with uncommitted changes, untracked files included (both sides of a rename). */
export function uncommittedPaths(cwd: string): string[] {
  const out = gitRun(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout;
  return out.split('\0').filter(Boolean).map(entry => entry.slice(3));
}
