/**
 * The agent guard (.claude/hooks/guard-core.mjs): Claude Code runs it before
 * every Edit, Write, MultiEdit and NotebookEdit. In an install it blocks edits
 * to core files (exit 2, a plain line on stderr) and lets through client-owned
 * paths, files outside the repo, gitignored files, and anything while a merge
 * is in progress. In the source monorepo it allows everything. When it cannot
 * decide it allows the edit and says why (check:core still guards the commit).
 *
 * Its path rules must stay identical to scripts/lib/core-paths.ts: this test
 * compares the two on the same paths and on the string literals each uses.
 *
 * Builds scratch layouts in a temp folder and deletes them afterwards.
 *
 *   npm run -s test:agent-guard
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_EDITABLE_CORE, isAllowedInstallChange, isClientOwned, isSourceMonorepo } from './lib/core-paths';

const APP = join(__dirname, '..');
const HOOK = join(APP, '.claude', 'hooks', 'guard-core.mjs');
const CORE_PATHS = join(APP, 'scripts', 'lib', 'core-paths.ts');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

interface HookRun { code: number | null; stderr: string; ms: number }

function runHook(hookPath: string, stdin: string, cwd: string): HookRun {
  const started = Date.now();
  const result = spawnSync(process.execPath, [hookPath], { input: stdin, cwd, encoding: 'utf8', timeout: 10_000 });
  return { code: result.status, stderr: result.stderr ?? '', ms: Date.now() - started };
}

function edit(hookPath: string, cwd: string, filePath: string, tool = 'Edit'): HookRun {
  const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const payload = { session_id: 'test', hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: { [key]: filePath } };
  return runHook(hookPath, JSON.stringify(payload), cwd);
}

function placeHook(appRoot: string): string {
  const target = join(appRoot, '.claude', 'hooks', 'guard-core.mjs');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(HOOK, target);
  return target;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** The code of a file's isClientOwned function body, without comments or whitespace. */
function bodyOf(source: string, file: string): string {
  const fn = source.match(/function isClientOwned\([^)]*\)[^{]*\{([\s\S]*?)\n}/);
  if (!fn) throw new Error(`no isClientOwned function in ${file}`);
  return fn[1].replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s+/g, '');
}

/** The string literals in that body. */
function literalsOf(body: string): string[] {
  return [...new Set([...body.matchAll(/'([^'\n]*)'/g)].map(m => m[1]))].filter(s => /[a-z]/i.test(s)).sort();
}

/** What core-paths.ts must answer: client-owned (true) or core (false). */
const EXPECTED: Array<[string, boolean]> = [
  ['src/custom/pages/Reports.tsx', true],
  ['supabase/migrations/custom/20261201120000_scores.sql', true],
  ['public/custom/logo.svg', true],
  ['.claude/skills/our-deploy/SKILL.md', true],
  ['.claude/skills/pm-upgrade/SKILL.md', false],
  ['.claude/agents/reviewer.md', true],
  ['.claude/agents/our-team/reviewer.md', true],
  ['.claude/agents/pm-reviewer.md', false],
  ['.claude/commands/deploy.md', true],
  ['.claude/commands/ops/deploy.md', true],
  ['.claude/commands/pm-release.md', false],
  ['.github/workflows/custom-nightly.yml', true],
  ['.github/workflows/custom-deploy.yaml', true],
  ['.github/workflows/core-checks.yml', false],
  ['.github/workflows/nightly-custom.yml', false],
  ['.github/workflows/custom-x/a.yml', false],
  ['.github/custom-x.yml', false],
  ['.claude/settings.json', false],
  ['.claude/settings.local.json', true],
  ['.claude/hooks/guard-core.mjs', false],
  ['README.md', false],
  ['.env.local', true],
  ['.env.example', false],
];

/* ------------------------------------------------------------------ */
/* The hook's path list matches core-paths.ts                          */
/* ------------------------------------------------------------------ */

async function listCases() {
  const hook = await import(pathToFileURL(HOOK).href);
  check('list: CLIENT_EDITABLE_CORE matches core-paths.ts',
    JSON.stringify(hook.CLIENT_EDITABLE_CORE) === JSON.stringify(CLIENT_EDITABLE_CORE),
    { hook: hook.CLIENT_EDITABLE_CORE, core: CLIENT_EDITABLE_CORE });

  const coreBody = bodyOf(readFileSync(CORE_PATHS, 'utf8'), 'core-paths.ts');
  const hookBody = bodyOf(readFileSync(HOOK, 'utf8'), 'guard-core.mjs');
  check('list: isClientOwned has the same code in both files', coreBody === hookBody, { core: coreBody, hook: hookBody });
  const coreLiterals = literalsOf(coreBody);

  for (const [path, owned] of EXPECTED) {
    check(`rules: core-paths says ${path} is ${owned ? 'client-owned' : 'core'}`, isClientOwned(path) === owned);
  }

  const corpus = new Set<string>([
    ...EXPECTED.map(([path]) => path),
    'src/custom/index.ts', 'src/custom/pages/Reports.tsx', 'src/customer/x.ts', 'src/custom', 'src/app/page.tsx',
    'supabase/migrations/custom/20261201120000_scores.sql', 'supabase/migrations/20261120194316_workspace_modules.sql',
    'supabase/schema.sql', 'public/custom/logo.svg', 'public/logo.svg', 'public/customs/x.png',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/guard-core.mjs',
    '.claude/skills/pm-upgrade/SKILL.md', '.claude/skills/our-deploy/SKILL.md', '.claude/skills/PM-x/SKILL.md', '.claude/skills/x.md',
    '.env', '.env.local', '.env.production', '.env.example', 'config/.env.staging', 'src/.envrc',
    'package.json', 'package-lock.json', 'vercel.json', 'src/package.json', 'AGENTS.md', 'CLAUDE.md', 'src/custom/AGENTS.md',
    './src/custom/api.ts', 'src\\custom\\api.ts', 'src\\app\\layout.tsx', 'README.md', 'CHANGELOG.md',
  ]);
  for (const literal of coreLiterals) {
    corpus.add(literal);
    corpus.add(literal.endsWith('/') ? `${literal}deep/file.ts` : `${literal}x`);
  }
  for (const path of corpus) {
    check(`list: isClientOwned(${path}) agrees`, hook.isClientOwned(path) === isClientOwned(path), { hook: hook.isClientOwned(path), core: isClientOwned(path) });
    check(`list: isAllowedInstallChange(${path}) agrees`, hook.isAllowedInstallChange(path) === isAllowedInstallChange(path),
      { hook: hook.isAllowedInstallChange(path), core: isAllowedInstallChange(path) });
  }
}

/* ------------------------------------------------------------------ */
/* Decisions on real layouts                                           */
/* ------------------------------------------------------------------ */

function layoutCases(tmp: string) {
  // An install: the app is the git top level.
  const install = join(tmp, 'install');
  mkdirSync(install, { recursive: true });
  git(install, ['init', '--quiet']);
  writeFileSync(join(install, 'package.json'), '{"name":"pm"}\n');
  writeFileSync(join(install, '.gitignore'), 'tasks/scratch/\n.claude/worktrees/\n');
  const hook = placeHook(install);
  const at = (p: string) => join(install, p);

  let r = edit(hook, install, at('src/app/page.tsx'));
  check('install: a core file is blocked (exit 2)', r.code === 2, r);
  check('install: the message names the file', r.stderr.includes('src/app/page.tsx'), r.stderr);
  check('install: the message says where to put it', r.stderr.includes('src/custom') && r.stderr.includes('pm-propose-core-change'), r.stderr);
  check('install: the hook answers fast', r.ms < 2000, r.ms);

  r = edit(hook, install, 'src/lib/utils.ts');
  check('install: a relative core path is blocked', r.code === 2, r);
  r = edit(hook, install, at('.claude/hooks/guard-core.mjs'), 'Write');
  check('install: the guard itself is core', r.code === 2, r);
  r = edit(hook, install, at('.claude/skills/pm-upgrade/SKILL.md'), 'MultiEdit');
  check('install: a core skill (pm-*) is blocked', r.code === 2, r);
  r = edit(hook, install, at('.env.example'));
  check('install: .env.example is core', r.code === 2, r);
  r = edit(hook, install, at('analysis/report.ipynb'), 'NotebookEdit');
  check('install: a notebook in core is blocked (notebook_path)', r.code === 2, r);

  for (const allowed of ['src/custom/pages/Reports.tsx', 'supabase/migrations/custom/20261201120000_scores.sql', 'public/custom/logo.svg',
    '.claude/skills/our-deploy/SKILL.md', '.claude/settings.local.json', '.env.local', 'package.json', 'vercel.json', 'tasks/scratch/plan.md']) {
    r = edit(hook, install, at(allowed), 'Write');
    check(`install: ${allowed} is allowed`, r.code === 0, r);
  }
  r = edit(hook, install, join(tmp, 'elsewhere', 'notes.md'), 'Write');
  check('install: a file outside the repo is allowed', r.code === 0, r);
  r = edit(hook, install, at('.claude/agents/reviewer.md'), 'Write');
  check('install: its own agent definition is allowed', r.code === 0, r);
  r = edit(hook, install, at('.github/workflows/custom-nightly.yml'), 'Write');
  check('install: its own custom-* workflow is allowed', r.code === 0, r);
  r = edit(hook, install, at('.github/workflows/core-checks.yml'));
  check('install: a core workflow is blocked', r.code === 2, r);

  // Reached through a junction (Windows) or symlink: the guard still runs.
  const linked = join(tmp, 'linked-install');
  symlinkSync(install, linked, process.platform === 'win32' ? 'junction' : 'dir');
  r = edit(join(linked, '.claude', 'hooks', 'guard-core.mjs'), linked, join(linked, 'src', 'app', 'page.tsx'));
  check('linked path: a core file is still blocked', r.code === 2, r);
  r = edit(join(linked, '.claude', 'hooks', 'guard-core.mjs'), linked, join(linked, 'src', 'custom', 'x.ts'));
  check('linked path: a client-owned file is allowed', r.code === 0, r);

  // A worktree checked out inside the install (gitignored there) follows the same rules.
  const nestedWt = join(install, '.claude', 'worktrees', 'feature');
  mkdirSync(nestedWt, { recursive: true });
  writeFileSync(join(nestedWt, '.git'), `gitdir: ${join(install, '.git', 'worktrees', 'feature')}\n`);
  mkdirSync(join(install, '.git', 'worktrees', 'feature'), { recursive: true });
  r = edit(hook, install, join(nestedWt, 'src', 'app', 'page.tsx'));
  check('nested worktree: a core file is blocked though the folder is gitignored', r.code === 2, r);
  check('nested worktree: the message names the path inside that checkout', /Blocked: src\/app\/page\.tsx /.test(r.stderr), r.stderr);
  r = edit(hook, install, join(nestedWt, 'src', 'custom', 'reports.tsx'), 'Write');
  check('nested worktree: a client-owned file is allowed', r.code === 0, r);
  writeFileSync(join(install, '.git', 'worktrees', 'feature', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  r = edit(hook, install, join(nestedWt, 'src', 'app', 'page.tsx'));
  check('nested worktree: a merge open in that worktree allows core files', r.code === 0, r);

  // A merge in progress: resolving an upgrade conflict touches core files.
  writeFileSync(join(install, '.git', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  r = edit(hook, install, at('src/app/page.tsx'));
  check('merge in progress: a core file is allowed', r.code === 0, r);
  rmSync(join(install, '.git', 'MERGE_HEAD'));
  r = edit(hook, install, at('src/app/page.tsx'));
  check('merge finished: a core file is blocked again', r.code === 2, r);

  // A linked worktree: .git is a file naming the real git dir.
  const wt = join(tmp, 'worktree');
  const gitdir = join(tmp, 'gitdirs', 'worktree');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), 'gitdir: ../gitdirs/worktree\n');
  writeFileSync(join(wt, 'package.json'), '{"name":"pm"}\n');
  const wtHook = placeHook(wt);
  r = edit(wtHook, wt, join(wt, 'src', 'app', 'page.tsx'));
  check('worktree: a core file is blocked', r.code === 2, r);
  writeFileSync(join(gitdir, 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  r = edit(wtHook, wt, join(wt, 'src', 'app', 'page.tsx'));
  check('worktree: a merge in its git dir allows core files', r.code === 0, r);

  // The source monorepo: the git top level holds app/package.json.
  const mono = join(tmp, 'mono');
  mkdirSync(join(mono, '.git'), { recursive: true });
  mkdirSync(join(mono, 'app'), { recursive: true });
  writeFileSync(join(mono, 'app', 'package.json'), '{"name":"pm"}\n');
  const monoHook = placeHook(join(mono, 'app'));
  r = edit(monoHook, mono, join(mono, 'app', 'src', 'app', 'page.tsx'));
  check('source monorepo: core files are allowed', r.code === 0, r);
  r = edit(monoHook, join(mono, 'app'), 'supabase/schema.sql');
  check('source monorepo: relative core paths are allowed', r.code === 0, r);

  // Cannot decide: allow, and say why on stderr.
  r = runHook(hook, 'not json', install);
  check('bad input: allowed', r.code === 0, r);
  check('bad input: says it could not decide', /could not/i.test(r.stderr), r.stderr);
  r = runHook(hook, JSON.stringify({ tool_name: 'Edit', tool_input: {} }), install);
  check('no file path: allowed', r.code === 0, r);
  const nested = join(tmp, 'vendored');
  mkdirSync(join(nested, '.git'), { recursive: true });
  mkdirSync(join(nested, 'pm'), { recursive: true });
  const nestedHook = placeHook(join(nested, 'pm'));
  r = edit(nestedHook, nested, join(nested, 'pm', 'src', 'app', 'page.tsx'));
  check('app below the git top level (not app/): allowed with a note', r.code === 0 && r.stderr.length > 0, r);
}

/* ------------------------------------------------------------------ */
/* This repository                                                     */
/* ------------------------------------------------------------------ */

function thisRepoCase() {
  const r = edit(HOOK, APP, join(APP, 'src', 'app', 'layout.tsx'));
  const source = isSourceMonorepo(APP);
  check('this repo: the hook agrees with isSourceMonorepo', source ? r.code === 0 : r.code === 2, { source, run: r });
  const settings = JSON.parse(readFileSync(join(APP, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks?.PreToolUse?.[0];
  check('settings: PreToolUse matches every edit tool', entry?.matcher === 'Edit|Write|MultiEdit|NotebookEdit', entry);
  check('settings: runs the guard with node', /^node .*\.claude\/hooks\/guard-core\.mjs/.test(entry?.hooks?.[0]?.command ?? ''), entry);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-guard-'));
  try {
    if (!existsSync(HOOK)) throw new Error(`${HOOK} is missing`);
    await listCases();
    layoutCases(tmp);
    thisRepoCase();
  } catch (err) {
    failures.push(`crashed: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  if (failures.length) {
    console.error(`agent-guard: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`agent-guard: all ${passed} checks passed`);
}

void main();
