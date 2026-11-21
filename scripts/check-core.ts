/**
 * Keeps an install upgradable: its own changes live only in client-owned
 * paths (src/custom, supabase/migrations/custom, public/custom, its own
 * .claude skills, agents, commands and settings.local.json,
 * .github/workflows/custom-*.yml, .env files; the full list is
 * scripts/lib/core-paths.ts), so release merges never conflict.
 *
 * Fails (exit 1) when:
 *   1. A file outside those paths differs from the newest release in this
 *      install's history (in any commit, merge commits included) or has
 *      uncommitted changes, and still differs from that release. With no
 *      release merged yet, commits outside every release tag count.
 *      package.json, package-lock.json and vercel.json are core files an
 *      install may change; the upgrade merges them.
 *   2. A custom migration creates, alters or drops anything outside schema custom.
 *
 * In the source monorepo (the releases are cut from it) there is nothing to
 * police: it says so and exits 0.
 *
 *   npm run check:core
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedInstallChange, isSourceMonorepo } from './lib/core-paths';
import { checkCustomSql, type SqlViolation } from './lib/custom-sql';
import { byName } from './lib/migrations';
import { git, gitRun, lines, releaseTags, uncommittedPaths } from './lib/git';

export interface CoreCheckResult {
  exitCode: number;
  source: boolean;
  /** Core files this install changed. */
  coreFiles: string[];
  sqlViolations: (SqlViolation & { file: string })[];
  messages: string[];
}

export function checkCore(root: string): CoreCheckResult {
  const result: CoreCheckResult = { exitCode: 0, source: false, coreFiles: [], sqlViolations: [], messages: [] };
  const say = (line: string) => result.messages.push(line);

  if (isSourceMonorepo(root)) {
    result.source = true;
    say('This is the source install (the monorepo releases are cut from): core files are edited here, nothing to check.');
    return result;
  }
  if (gitRun(root, ['rev-parse', '--show-prefix']).stdout.trim() !== '') {
    say('Run check:core from the repository root: the app must be the top level of its git repository.');
    result.exitCode = 1;
    return result;
  }

  // 1. Core files changed by this install.
  const tags = releaseTags(root);
  if (!tags.length) {
    say('No release tags (vX.Y.Z) in this repository, so core changes cannot be told apart. Fetch them: git fetch upstream --tags');
    result.exitCode = 1;
  } else {
    // Compare with the newest release in HEAD's history: this catches edits made
    // inside merge commits (a hand-resolved update) as well as ordinary commits.
    // With no release in the history yet, fall back to commits outside every release.
    const [latest] = releaseTags(root, ['--merged', 'HEAD']);
    const committed = latest
      ? lines(git(root, ['diff', '--name-only', '--no-renames', latest, 'HEAD', '--']))
      : lines(git(root, ['log', '--no-merges', '--no-renames', '--name-only', '--format=', 'HEAD', '--not', ...tags]));
    const touched = new Set([...committed, ...uncommittedPaths(root)]);
    const candidates = [...touched].filter(path => !isAllowedInstallChange(path));
    // A file edited and later restored to the release's copy is not a change.
    let differs: Set<string> | null = null;
    if (latest && candidates.length) {
      differs = new Set([
        ...lines(git(root, ['diff', '--name-only', '--no-renames', latest, '--'])),
        ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
      ]);
    }
    result.coreFiles = candidates.filter(path => !differs || differs.has(path)).sort(byName);
    if (result.coreFiles.length) {
      say(`Core files changed in this install (${result.coreFiles.length}):`);
      for (const path of result.coreFiles) say(`  ${path}`);
      say('Move each change into src/custom (or another client-owned path), or propose it upstream so it ships in a release.');
      result.exitCode = 1;
    }
  }

  // 2. Custom migrations stay in schema custom.
  const customDir = join(root, 'supabase', 'migrations', 'custom');
  const files = existsSync(customDir) ? readdirSync(customDir).filter(name => name.endsWith('.sql')).sort(byName) : [];
  for (const file of files) {
    const path = `supabase/migrations/custom/${file}`;
    for (const violation of checkCustomSql(readFileSync(join(customDir, file), 'utf8'))) {
      result.sqlViolations.push({ file: path, ...violation });
    }
  }
  if (result.sqlViolations.length) {
    say(`Custom migrations reach outside schema custom (${result.sqlViolations.length}):`);
    for (const v of result.sqlViolations) say(`  ${v.file}: ${v.reason}\n    ${v.statement}`);
    say('Keep install tables, functions and policies in schema custom; a change to a core table belongs upstream.');
    result.exitCode = 1;
  }

  if (result.exitCode === 0) say(`Core is untouched and ${files.length} custom migration(s) stay in schema custom.`);
  return result;
}

if (require.main === module) {
  try {
    const result = checkCore(process.cwd());
    for (const line of result.messages) (result.exitCode ? console.error : console.log)(line);
    process.exit(result.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
