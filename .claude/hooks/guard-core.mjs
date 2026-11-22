#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (.claude/settings.json) for Edit, Write,
 * MultiEdit and NotebookEdit: stops an agent in an install from editing core
 * files, which every release replaces.
 *
 * Reads the hook JSON from stdin ({ tool_name, tool_input: { file_path |
 * notebook_path }, cwd }). Exit 0 allows the edit; exit 2 blocks it and
 * Claude Code shows stderr to the agent.
 *
 * Allows: files outside the app, client-owned paths, gitignored files, every
 * path in the source monorepo (its git top level holds app/package.json), and
 * every path while a merge is in progress (resolving an upgrade conflict).
 * A checkout inside the app (a worktree in .claude/worktrees/<name>) is
 * judged by the same rules, relative to its own root.
 * When it cannot decide, it allows the edit and says why on stderr:
 * npm run check:core still guards the commit.
 *
 * The path rules below must match scripts/lib/core-paths.ts exactly.
 * scripts/verify-agent-guard.ts fails when they drift.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Copied from scripts/lib/core-paths.ts: keep identical. */

/** Core files an install legitimately changes; the upgrade merges them as JSON (the lockfile is regenerated). */
export const CLIENT_EDITABLE_CORE = ['package.json', 'package-lock.json', 'vercel.json'];

/** True for paths the install owns. Paths are relative to the app root, with forward slashes. */
export function isClientOwned(path) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('src/custom/') || p.startsWith('supabase/migrations/custom/') || p.startsWith('public/custom/')) return true;
  if (p === '.claude/settings.local.json') return true;
  // Core skills are named pm-*; any other skill folder is the install's.
  const skill = p.match(/^\.claude\/skills\/([^/]+)\//);
  if (skill) return !skill[1].startsWith('pm-');
  // Agent definitions and commands, files or folders: pm-* are core, the rest the install's.
  const agentOrCommand = p.match(/^\.claude\/(?:agents|commands)\/([^/]+)/);
  if (agentOrCommand) return !agentOrCommand[1].startsWith('pm-');
  // The install's own CI: .github/workflows/custom-*.yml (or .yaml).
  if (/^\.github\/workflows\/custom-[^/]+\.ya?ml$/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (base.startsWith('.env') && base !== '.env.example') return true;
  return false;
}

/** Files an install may change without check:core flagging them. */
export function isAllowedInstallChange(path) {
  return isClientOwned(path) || CLIENT_EDITABLE_CORE.includes(path);
}

/* The hook. */

const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The real path, for files that may not exist yet: the nearest existing folder is resolved. */
function canonical(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync.native(existing), ...rest);
  } catch {
    return path;
  }
}

/**
 * Another checkout inside the app, such as a worktree in .claude/worktrees/<name> (the app's
 * .gitignore hides it): the nearest folder holding .git between the target and the app root.
 */
function nestedCheckout(root, target) {
  for (let current = dirname(target); current !== root; current = dirname(current)) {
    if (relative(root, current).startsWith('..') || dirname(current) === current) return null;
    if (existsSync(join(current, '.git'))) return current;
  }
  return null;
}

/** The nearest folder at or above `dir` holding .git (a folder, or a file in a linked worktree). */
function gitTopLevel(dir) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}

function mergeInProgress(top) {
  const dotGit = join(top, '.git');
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!pointer) return false;
    gitDir = resolve(top, pointer[1]);
  }
  return existsSync(join(gitDir, 'MERGE_HEAD'));
}

function isGitIgnored(root, rel) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'ignore', timeout: 3000 });
  return result.status === 0;
}

const allow = () => 0;

function cannotDecide(why) {
  process.stderr.write(`guard-core: could not check this edit (${why}), so it is allowed. npm run check:core still checks core files before a commit.\n`);
  return 0;
}

function block(rel) {
  process.stderr.write([
    `Blocked: ${rel} is a core file, and this install never edits core files.`,
    'Each release replaces core files, so an edit here would be lost or would stop the next update.',
    'Do this instead:',
    '  1. Put the change in a client-owned path: src/custom (pages, tabs, widgets, settings, API routes, theme),',
    '     supabase/migrations/custom (SQL in schema pm_custom), public/custom (files), .claude/skills, agents or commands',
    '     under a name not starting with pm-, or .github/workflows/custom-*.yml.',
    '     Skill: pm-add-custom-feature.',
    '  2. If no plug-in point can do it, write a core change proposal for Valiance Media instead. Skill: pm-propose-core-change.',
    'Rules: AGENTS.md.',
    '',
  ].join('\n'));
  return 2;
}

export function decide(stdin) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return cannotDecide('the hook input was not JSON');
  }
  const toolInput = input && typeof input === 'object' ? input.tool_input : null;
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof filePath !== 'string' || !filePath) return allow();

  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = canonical(APP_ROOT);
  const target = canonical(isAbsolute(filePath) ? filePath : resolve(base, filePath));
  const fromRoot = relative(root, target).replace(/\\/g, '/');
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) return allow();
  if (isAllowedInstallChange(fromRoot)) return allow();

  const top = gitTopLevel(root);
  if (!top) return cannotDecide('no git repository found');
  if (existsSync(join(top, 'app', 'package.json'))) return allow(); // the source monorepo
  if (relative(top, root) !== '') return cannotDecide(`the app is not the top level of its git repository (${top})`);

  // A checkout inside the app gets the same rules, relative to its own root.
  const checkout = nestedCheckout(root, target) ?? root;
  const rel = relative(checkout, target).replace(/\\/g, '/');
  if (checkout !== root) {
    if (isAllowedInstallChange(rel)) return allow();
    if (existsSync(join(checkout, 'app', 'package.json'))) return allow(); // a worktree of the source monorepo
  }
  if (mergeInProgress(checkout)) return allow();
  if (isGitIgnored(checkout, rel)) return allow();
  return block(rel);
}

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  try {
    process.exitCode = decide(stdin);
  } catch (err) {
    process.exitCode = cannotDecide(err instanceof Error ? err.message : String(err));
  }
}

// Run as a script, not when imported (the test imports the rules). Both sides are real paths:
// Node resolves import.meta.url through symlinks and junctions but not argv.
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const invoked = process.argv[1] ? canonical(resolve(process.argv[1])) : '';
if (invoked && sameFile(invoked, canonical(fileURLToPath(import.meta.url)))) {
  main().catch((err) => {
    process.stderr.write(`guard-core: could not check this edit (${err instanceof Error ? err.message : String(err)}), so it is allowed.\n`);
    process.exitCode = 0;
  });
}
