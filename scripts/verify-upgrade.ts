/**
 * Release upgrades: an install that keeps its own work in client-owned paths
 * merges each release tag with no conflicts; package.json and vercel.json keep
 * the install's dependencies, scripts and crons while taking the release's;
 * the history is a true merge; the summary lists the release's migrations;
 * check:core catches core edits and custom migrations that reach outside
 * schema pm_custom; and a real conflict aborts cleanly with exit code 2.
 *
 * Builds scratch git repos (an "upstream" and a "client" cloned from it) in a
 * temp folder and deletes them afterwards. Also unit-tests the JSON merge, the
 * custom SQL rules and the client-owned path rules.
 *
 *   npm run -s test:upgrade
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkCore } from './check-core';
import { isAllowedInstallChange, isClientOwned } from './lib/core-paths';
import { checkCustomSql, customSchemaFor } from './lib/custom-sql';
import { git, gitRun } from './lib/git';
import { mergeJson, mergeJsonText, type Json } from './lib/json-merge';
import { clearGeneratedTypes, normalizeRemote, upgrade, type UpgradeSummary } from './upgrade';

const APP = join(__dirname, '..');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ */
/* JSON merge                                                          */
/* ------------------------------------------------------------------ */

function jsonMergeCases() {
  const pkg = (o: Record<string, Json>) => o as Json;

  // One side changes each value: both changes land.
  let r = mergeJson('package.json',
    pkg({ name: 'a', version: '1.0.0', dependencies: { next: '1', react: '1' } }),
    pkg({ name: 'client', version: '1.0.0', dependencies: { next: '1', react: '1' } }),
    pkg({ name: 'a', version: '1.1.0', dependencies: { next: '2', react: '1' } }));
  check('json: one-sided changes both land', same(r.merged, { name: 'client', version: '1.1.0', dependencies: { next: '2', react: '1' } }), r.merged);
  check('json: one-sided changes are not reported', r.notes.length === 0, r.notes);

  // Both bump the same dependency: the release wins, reported.
  r = mergeJson('package.json', pkg({ dependencies: { next: '1' } }), pkg({ dependencies: { next: '1.5' } }), pkg({ dependencies: { next: '2' } }));
  check('json: a dependency both changed takes the release', same(r.merged, { dependencies: { next: '2' } }), r.merged);
  check('json: and is reported', r.notes.length === 1 && r.notes[0].path === 'dependencies.next' && r.notes[0].took === 'theirs', r.notes);

  // Added by the install only: kept. Added by both differently: the release wins.
  r = mergeJson('package.json', pkg({ dependencies: { next: '1' } }), pkg({ dependencies: { acme: '1', next: '1', zed: '1' } }), pkg({ dependencies: { next: '1', zed: '2' } }));
  check('json: an install-only dependency is kept, a both-added one takes the release', same(r.merged, { dependencies: { acme: '1', next: '1', zed: '2' } }), r.merged);

  // Removed by the release: gone, unless the install changed it.
  r = mergeJson('package.json', pkg({ dependencies: { a: '1', b: '1' } }), pkg({ dependencies: { a: '1', b: '1.1' } }), pkg({ dependencies: {} }));
  check('json: a release removal applies, except where the install changed it', same(r.merged, { dependencies: { b: '1.1' } }), r.merged);
  check('json: the kept removal is reported as ours', r.notes.some(n => n.path === 'dependencies.b' && n.took === 'ours'), r.notes);

  // Removed by the install, untouched by the release: stays removed.
  r = mergeJson('package.json', pkg({ scripts: { dev: 'x', lint: 'y' } }), pkg({ scripts: { dev: 'x' } }), pkg({ scripts: { dev: 'x', lint: 'y' } }));
  check('json: an install removal stays removed', same(r.merged, { scripts: { dev: 'x' } }), r.merged);

  // Scripts both changed: the release wins.
  r = mergeJson('package.json', pkg({ scripts: { dev: 'next dev' } }), pkg({ scripts: { dev: 'next dev -p 3100' } }), pkg({ scripts: { dev: 'next dev --turbopack' } }));
  check('json: a script both changed takes the release', same(r.merged, { scripts: { dev: 'next dev --turbopack' } }), r.merged);

  // Other scalars both changed: the release wins, reported.
  r = mergeJson('package.json', pkg({ name: 'a' }), pkg({ name: 'b' }), pkg({ name: 'c' }));
  check('json: other scalars take the release and are reported', same(r.merged, { name: 'c' }) && r.notes[0]?.path === 'name', r);

  // Nested objects recurse.
  r = mergeJson('package.json', pkg({ engines: { node: '20', npm: '10' } }), pkg({ engines: { node: '22', npm: '10' } }), pkg({ engines: { node: '20', npm: '11' } }));
  check('json: nested objects merge key by key', same(r.merged, { engines: { node: '22', npm: '11' } }), r.merged);

  // Key order: ours, then new keys appended; an alphabetical dependency map stays alphabetical.
  r = mergeJson('package.json',
    pkg({ version: '1', name: 'a', dependencies: { b: '1', d: '1' } }),
    pkg({ version: '1', name: 'a', custom: true, dependencies: { b: '1', c: '1', d: '1' } }),
    pkg({ version: '2', name: 'a', added: 1, dependencies: { a: '1', b: '1', d: '1' } }));
  check('json: key order keeps ours and appends new keys', same(Object.keys(r.merged as object), ['version', 'name', 'custom', 'dependencies', 'added']), Object.keys(r.merged as object));
  check('json: an alphabetical dependency map stays alphabetical', same(Object.keys((r.merged as { dependencies: object }).dependencies), ['a', 'b', 'c', 'd']), r.merged);
  const again = mergeJson('package.json',
    pkg({ version: '1', name: 'a', dependencies: { b: '1', d: '1' } }),
    pkg({ version: '1', name: 'a', custom: true, dependencies: { b: '1', c: '1', d: '1' } }),
    pkg({ version: '2', name: 'a', added: 1, dependencies: { a: '1', b: '1', d: '1' } }));
  check('json: the merge is deterministic', JSON.stringify(again.merged) === JSON.stringify(r.merged));

  // vercel.json crons: union by path, release wins a shared path, removals respected.
  const cron = (path: string, schedule: string) => ({ path, schedule });
  const base = { crons: [cron('/a', '1'), cron('/b', '2'), cron('/c', '3'), cron('/e', '5')] };
  const ours = { crons: [cron('/a', '1'), cron('/b', '22'), cron('/c', '33'), cron('/mine', '9')] }; // e removed by the install
  const theirs = { crons: [cron('/b', '222'), cron('/e', '5'), cron('/new', '7')] }; // a, c removed by the release
  r = mergeJson('vercel.json', base, ours, theirs);
  check('crons: union by path with the right winners',
    same(r.merged, { crons: [cron('/b', '222'), cron('/c', '33'), cron('/mine', '9'), cron('/new', '7')] }), r.merged);
  check('crons: the release wins a path both changed (reported)', r.notes.some(n => n.path === 'crons[/b]' && n.took === 'theirs'), r.notes);
  check('crons: a release-removed cron the install changed is kept (reported)', r.notes.some(n => n.path === 'crons[/c]' && n.took === 'ours'), r.notes);
  r = mergeJson('vercel.json', base, { crons: [cron('/a', '1'), cron('/b', '2'), cron('/c', '3')] }, { crons: [...base.crons.slice(0, 3), cron('/e', '55')] });
  check('crons: an install-removed cron the release changed comes back', same(r.merged, { crons: [cron('/a', '1'), cron('/b', '2'), cron('/c', '3'), cron('/e', '55')] }), r.merged);

  // Text: indentation and line endings follow the install's copy; a missing base merges from {}.
  const text = mergeJsonText('package.json', null, '{\r\n    "name": "a"\r\n}\r\n', '{\n  "version": "1"\n}\n');
  check('json text: keeps the install indentation and CRLF', text.text === '{\r\n    "name": "a",\r\n    "version": "1"\r\n}\r\n', text.text);
  let threw = false;
  try { mergeJsonText('vercel.json', '{}', '{ bad', '{}'); } catch { threw = true; }
  check('json text: invalid JSON throws', threw);
}

/* ------------------------------------------------------------------ */
/* Custom SQL and client-owned paths                                   */
/* ------------------------------------------------------------------ */

/** Stale Next.js route types are cleared before type-checking; the rest of .next stays. */
function generatedTypesCases() {
  const root = mkdtempSync(join(tmpdir(), 'pm-next-types-'));
  try {
    for (const file of ['.next/types/validator.ts', '.next/dev/types/routes.d.ts', '.next/cache/keep.json', '.next/BUILD_ID']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'x');
    }
    clearGeneratedTypes(root);
    check('upgrade: generated route types are cleared before type-checking',
      !existsSync(join(root, '.next/types')) && !existsSync(join(root, '.next/dev/types')));
    check('upgrade: the rest of .next is left alone',
      existsSync(join(root, '.next/cache/keep.json')) && existsSync(join(root, '.next/BUILD_ID')));
    clearGeneratedTypes(root);
    check('upgrade: clearing twice is harmless', true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rulesCases() {
  const ok = (sql: string) => {
    const v = checkCustomSql(sql);
    check(`sql allowed: ${sql.slice(0, 70)}`, v.length === 0, v);
  };
  const bad = (sql: string, pattern: RegExp) => {
    const v = checkCustomSql(sql);
    check(`sql refused: ${sql.slice(0, 70)}`, v.length > 0 && pattern.test(v[0].reason), v);
  };
  ok('CREATE SCHEMA IF NOT EXISTS pm_custom;');
  // Files dated before 2.0 were written for schema custom (the move renamed it), and still pass.
  check('sql: a file dated before 2.0 is checked against schema custom', customSchemaFor('20260201000000_old.sql') === 'custom' && customSchemaFor('20270101000000_new.sql') === 'pm_custom');
  check('sql: and custom is allowed there', checkCustomSql('create table custom.notes (id int);', 'custom').length === 0);
  check('sql: but not in a 2.0 file', checkCustomSql('create table custom.notes (id int);').length === 1);
  ok('create table if not exists pm_custom.notes (id uuid primary key, task_id uuid references pm.tasks(id) on delete cascade, note text);');
  ok('CREATE UNIQUE INDEX IF NOT EXISTS notes_task ON pm_custom.notes (task_id);');
  ok('create index on only pm_custom.notes using btree (note);');
  ok('alter table pm_custom.notes enable row level security;');
  ok('CREATE POLICY "notes read" ON pm_custom.notes FOR SELECT TO authenticated USING (exists (select 1 from pm.team_members m where m.id = auth.uid()));');
  ok('drop policy if exists "notes read" on pm_custom.notes;');
  ok('CREATE OR REPLACE FUNCTION pm_custom.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE pm.tasks SET updated_at = now(); RETURN NEW; END $$;');
  ok('create trigger notes_touch before insert or update on pm_custom.notes for each row execute function pm_custom.touch();');
  ok('GRANT USAGE ON SCHEMA pm_custom TO authenticated; GRANT SELECT, INSERT ON pm_custom.notes TO authenticated; GRANT ALL ON ALL TABLES IN SCHEMA pm_custom TO service_role;');
  ok('grant execute on function pm_custom.touch() to authenticated;');
  ok('ALTER DEFAULT PRIVILEGES IN SCHEMA pm_custom GRANT SELECT ON TABLES TO authenticated;');
  ok('comment on table pm_custom.notes is \'Notes; with a semicolon\'; comment on column pm_custom.notes.note is \'text\';');
  ok('insert into pm_custom.notes (note) values (\'x\') on conflict do nothing; update pm_custom.notes set note = \'y\'; delete from pm_custom.notes where note is null;');
  ok('DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = \'fk\') THEN ALTER TABLE pm_custom.notes ADD CONSTRAINT fk FOREIGN KEY (task_id) REFERENCES pm.tasks(id); END IF; END $$;');
  ok('alter publication supabase_realtime add table pm_custom.notes;');
  ok('BEGIN; set local search_path = custom, public; select 1; notify pgrst, \'reload schema\'; COMMIT;');
  ok('drop table if exists pm_custom.old_notes, pm_custom.older_notes cascade; drop function if exists pm_custom.touch(uuid, text);');
  ok('-- ALTER TABLE pm.tasks ADD COLUMN x int;\n/* drop table pm.tasks; */ select 1;');
  bad('ALTER TABLE pm.tasks ADD COLUMN acme text;', /pm.tasks/);
  bad('create table notes (id int);', /without a schema/);
  bad('CREATE INDEX tasks_acme ON pm.tasks (title);', /pm.tasks/);
  bad('create policy p on pm.tasks for select using (true);', /pm.tasks/);
  bad('create trigger t after insert on pm.tasks for each row execute function pm_custom.f();', /pm.tasks/);
  bad('CREATE OR REPLACE FUNCTION pm.has_permission(text) RETURNS boolean LANGUAGE sql AS $$ select true $$;', /pm.has_permission/);
  bad('drop table if exists pm_custom.a, pm.tasks;', /pm.tasks/);
  bad('create schema acme;', /schema acme/);
  bad('create extension if not exists pg_trgm;', /database-wide/);
  bad('grant select on pm.tasks to anon;', /pm.tasks/);
  bad('grant authenticated to acme_role;', /role membership/);
  bad('insert into pm.settings (key) values (\'x\');', /pm.settings/);
  bad('update pm.tasks set title = \'x\';', /pm.tasks/);
  bad('truncate pm.tasks;', /pm.tasks/);
  bad('DO $$ BEGIN ALTER TABLE pm.tasks ADD COLUMN x int; END $$;', /inside DO.*pm.tasks/);
  bad('DO $$ BEGIN EXECUTE format(\'drop table %I\', \'tasks\'); END $$;', /dynamic SQL/);
  bad('DO $$ BEGIN EXECUTE \'drop table pm.tasks\'; END $$;', /pm.tasks/);
  bad('alter publication supabase_realtime set table pm_custom.notes;', /ADD TABLE/);
  bad('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon;', /IN SCHEMA pm_custom/);
  bad('comment on column notes.note is \'x\';', /without a schema/);
  bad('VACUUM pm.tasks;', /not allowed/);

  const owned = ['src/custom/index.ts', 'supabase/migrations/custom/1.sql', 'public/custom/logo.svg', '.claude/settings.local.json',
    '.claude/skills/acme-sales/SKILL.md', '.env.local', '.env.production'];
  const core = ['src/core.ts', 'src/customer.ts', 'supabase/migrations/1.sql', '.claude/settings.json', '.claude/skills/pm-review/SKILL.md',
    '.env.example', 'package.json', 'AGENTS.md', '.github/workflows/ci.yml', 'public/pm_custom.svg'];
  check('paths: client-owned paths are recognised', owned.every(isClientOwned), owned.filter(p => !isClientOwned(p)));
  check('paths: core paths are not client-owned', core.every(p => !isClientOwned(p)), core.filter(isClientOwned));
  check('paths: package.json, package-lock.json and vercel.json are allowed install changes',
    ['package.json', 'package-lock.json', 'vercel.json'].every(isAllowedInstallChange) && !isAllowedInstallChange('src/core.ts'));
  check('remotes: https and ssh forms of one repo match',
    normalizeRemote('https://github.com/Owner/Repo.git') === normalizeRemote('git@github.com:owner/repo') &&
    normalizeRemote('https://github.com/owner/repo/') !== normalizeRemote('https://github.com/owner/other'));
}

/* ------------------------------------------------------------------ */
/* Scratch repos                                                       */
/* ------------------------------------------------------------------ */

const tmp = mkdtempSync(join(tmpdir(), 'vm-upgrade-'));
const upstream = join(tmp, 'upstream');
const client = join(tmp, 'client');

// Isolate git from this machine's settings (signing, hooks, line endings) and give it an identity.
const emptyConfig = join(tmp, 'gitconfig');
writeFileSync(emptyConfig, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
});

function put(repo: string, path: string, content: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
const read = (repo: string, path: string) => readFileSync(join(repo, path), 'utf8');
function commit(repo: string, message: string) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}
function release(version: string) {
  const pkg = JSON.parse(read(upstream, 'package.json'));
  pkg.version = version;
  put(upstream, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  commit(upstream, `Release ${version}`);
  git(upstream, ['tag', '-a', `v${version}`, '-m', `v${version}`]);
}
function editJson(repo: string, path: string, edit: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(read(repo, path));
  edit(value);
  put(repo, path, `${JSON.stringify(value, null, 2)}\n`);
}

const PACKAGE_V1 = `{
  "name": "pm-app",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3009",
    "build": "next build",
    "test:core": "echo ok"
  },
  "dependencies": {
    "next": "16.0.0",
    "react": "19.0.0",
    "zod": "4.0.0"
  },
  "devDependencies": {
    "typescript": "5.0.0"
  }
}
`;
const VERCEL_V1 = `{
  "crons": [
    { "path": "/api/a", "schedule": "0 1 * * *" },
    { "path": "/api/b", "schedule": "0 2 * * *" }
  ]
}
`;
const CUSTOM_MIGRATION = `-- Acme's notes on tasks.
CREATE SCHEMA IF NOT EXISTS pm_custom;
GRANT USAGE ON SCHEMA pm_custom TO authenticated;
CREATE TABLE IF NOT EXISTS pm_custom.acme_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES pm.tasks(id) ON DELETE CASCADE,
  body text NOT NULL
);
CREATE INDEX IF NOT EXISTS acme_notes_task ON pm_custom.acme_notes (task_id);
ALTER TABLE pm_custom.acme_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read notes" ON pm_custom.acme_notes;
CREATE POLICY "members read notes" ON pm_custom.acme_notes FOR SELECT TO authenticated USING (true);
`;

function runCli(args: string[]): { code: number; output: string } {
  const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), '--tsconfig', join(APP, 'tsconfig.mcp-test.json'), join(APP, 'scripts', 'upgrade.ts'), ...args], {
    cwd: client, encoding: 'utf8', env: process.env,
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

function runUpgrade(extra: Partial<Parameters<typeof upgrade>[0]> = {}): UpgradeSummary {
  return upgrade({ root: client, skipChecks: true, upstreamUrl: upstream, ...extra });
}

function scenario() {
  // Upstream v1.0.0: a minimal app-shaped tree with the client-owned stubs.
  mkdirSync(upstream);
  git(upstream, ['init', '-q', '-b', 'main']);
  put(upstream, 'package.json', PACKAGE_V1);
  put(upstream, 'vercel.json', VERCEL_V1);
  put(upstream, 'AGENTS.md', '# Agent instructions\n\nCore rules.\n');
  put(upstream, 'src/core.ts', 'export const core = 1;\nexport const other = 1;\n');
  put(upstream, 'src/custom/index.ts', 'export const plugins = [];\n');
  put(upstream, 'public/custom/.gitkeep', '');
  put(upstream, 'supabase/migrations/custom/.gitkeep', '');
  put(upstream, 'supabase/migrations/20260101000000_init.sql', 'CREATE TABLE IF NOT EXISTS pm.tasks (id uuid PRIMARY KEY);\n');
  put(upstream, '.github/workflows/ci.yml', 'name: CI\non: [push]\n');
  put(upstream, '.claude/skills/pm-core/SKILL.md', '# Core skill\n');
  put(upstream, '.env.example', 'DATABASE_URL=\n');
  commit(upstream, 'Initial');
  git(upstream, ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);

  // The client: a full-history clone with work in every client-owned path.
  git(tmp, ['clone', '-q', upstream, client]);
  put(client, 'src/custom/index.ts', 'import { sync } from \'./sync\';\nexport const plugins = [sync];\n');
  put(client, 'src/custom/sync.ts', 'export const sync = () => \'acme\';\n');
  put(client, 'supabase/migrations/custom/20270201000000_acme_notes.sql', CUSTOM_MIGRATION);
  put(client, 'public/custom/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  put(client, '.claude/settings.local.json', '{ "permissions": {} }\n');
  put(client, '.claude/skills/acme-sales/SKILL.md', '# Acme sales\n');
  put(client, '.env.development', 'ACME_MODE=dev\n');
  // Text edits next to the lines the release changes, so git conflicts and the JSON merge must resolve them.
  put(client, 'package.json', PACKAGE_V1
    .replace('"dev": "next dev -p 3009"', '"dev": "next dev -p 3100"')
    .replace('"test:core": "echo ok"', '"test:core": "echo ok",\n    "acme:sync": "tsx src/custom/sync.ts"')
    .replace('"dependencies": {\n', '"dependencies": {\n    "acme-sdk": "1.0.0",\n'));
  put(client, 'vercel.json', VERCEL_V1.replace(
    '{ "path": "/api/b", "schedule": "0 2 * * *" }',
    '{ "path": "/api/b", "schedule": "0 2 * * *" },\n    { "path": "/api/custom/sync", "schedule": "0 5 * * *" }'));
  commit(client, 'Acme: own work');

  // A dirty tree is refused before anything happens.
  put(client, 'src/custom/wip.ts', 'export {};\n');
  const dirty = runUpgrade();
  check('upgrade: a dirty tree is refused', dirty.exitCode === 1 && /uncommitted/.test(dirty.message), dirty.message);
  rmSync(join(client, 'src/custom/wip.ts'));

  // Upstream v1.1.0: core changes, a dependency bump, a new and a removed cron, a workflow change, a migration.
  put(upstream, 'src/core.ts', 'export const core = 2;\nexport const other = 1;\n');
  put(upstream, 'AGENTS.md', '# Agent instructions\n\nCore rules, revised.\n');
  put(upstream, '.github/workflows/ci.yml', 'name: CI\non: [push, pull_request]\n');
  put(upstream, '.claude/skills/pm-core/SKILL.md', '# Core skill v2\n');
  put(upstream, 'supabase/migrations/20260301000000_add_column.sql', 'ALTER TABLE pm.tasks ADD COLUMN IF NOT EXISTS title text;\n');
  put(upstream, 'package.json', read(upstream, 'package.json')
    .replace('"dev": "next dev -p 3009"', '"dev": "next dev --turbopack -p 3009"')
    .replace('"next": "16.0.0"', '"next": "16.1.0"'));
  put(upstream, 'vercel.json', `{
  "crons": [
    { "path": "/api/b", "schedule": "30 2 * * *" },
    { "path": "/api/d", "schedule": "0 4 * * *" }
  ]
}
`);
  release('1.1.0');

  const first = runUpgrade({ branch: 'update/v1.1.0' });
  check('upgrade 1: exit 0', first.exitCode === 0, first.message);
  check('upgrade 1: merged from 1.0.0 to 1.1.0', first.merged && first.from === '1.0.0' && first.to === '1.1.0', first);
  check('upgrade 1: no conflicts left', first.conflicts.length === 0, first.conflicts);
  check('upgrade 1: package.json and vercel.json were resolved by the JSON merge',
    same(first.autoResolved.map(a => a.file).sort(), ['package.json', 'vercel.json']), first.autoResolved);
  check('upgrade 1: migrationsInRelease lists the new core migration', same(first.migrationsInRelease, ['20260301000000_add_column.sql']), first.migrationsInRelease);
  check('upgrade 1: on the new branch', git(client, ['symbolic-ref', '--short', 'HEAD']) === 'update/v1.1.0' && first.branch === 'update/v1.1.0');
  check('upgrade 1: the tag is an ancestor of HEAD', gitRun(client, ['merge-base', '--is-ancestor', 'v1.1.0', 'HEAD']).code === 0);
  check('upgrade 1: HEAD is a two-parent merge commit', git(client, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length === 3);
  check('upgrade 1: the merge message', git(client, ['log', '-1', '--format=%s']) === 'Update to v1.1.0', git(client, ['log', '-1', '--format=%s']));
  check('upgrade 1: the tree is clean', git(client, ['status', '--porcelain']) === '');

  const pkg1 = JSON.parse(read(client, 'package.json'));
  check('upgrade 1: version is the release', pkg1.version === '1.1.0', pkg1.version);
  check('upgrade 1: the release bump and the client dependency both land',
    same(pkg1.dependencies, { 'acme-sdk': '1.0.0', next: '16.1.0', react: '19.0.0', zod: '4.0.0' }), pkg1.dependencies);
  check('upgrade 1: the client script survives', pkg1.scripts['acme:sync'] === 'tsx src/custom/sync.ts', pkg1.scripts);
  check('upgrade 1: a script both changed takes the release', pkg1.scripts.dev === 'next dev --turbopack -p 3009', pkg1.scripts.dev);
  check('upgrade 1: that override is reported', first.autoResolved.some(a => a.notes.some(n => n.path === 'scripts.dev' && n.took === 'theirs')), first.autoResolved);
  const vercel1 = JSON.parse(read(client, 'vercel.json'));
  check('upgrade 1: crons merged (release removal, release change, client cron, release cron)', same(vercel1.crons, [
    { path: '/api/b', schedule: '30 2 * * *' },
    { path: '/api/custom/sync', schedule: '0 5 * * *' },
    { path: '/api/d', schedule: '0 4 * * *' },
  ]), vercel1.crons);
  check('upgrade 1: core files took the release',
    read(client, 'src/core.ts').startsWith('export const core = 2;') && read(client, '.github/workflows/ci.yml').includes('pull_request') && read(client, 'AGENTS.md').includes('revised'));
  check('upgrade 1: client-owned files are untouched',
    read(client, 'src/custom/index.ts').includes('sync') && existsSync(join(client, '.claude/skills/acme-sales/SKILL.md')) &&
    read(client, 'supabase/migrations/custom/20270201000000_acme_notes.sql') === CUSTOM_MIGRATION && existsSync(join(client, 'public/custom/logo.svg')));
  const core1 = checkCore(client);
  check('check:core passes after the upgrade', core1.exitCode === 0, core1.messages);

  // Back on main for the next round, as after merging the update pull request.
  git(client, ['checkout', '-q', 'main']);
  git(client, ['merge', '-q', '--ff-only', 'update/v1.1.0']);

  // Upstream v1.2.0 while the client keeps working.
  put(upstream, 'src/core.ts', 'export const core = 3;\nexport const other = 1;\n');
  put(upstream, 'supabase/migrations/20260401000000_more.sql', 'CREATE TABLE IF NOT EXISTS pm.more (id int);\n');
  editJson(upstream, 'package.json', p => { (p.dependencies as Record<string, string>)['lucide-react'] = '1.0.0'; p.dependencies = Object.fromEntries(Object.entries(p.dependencies as object).sort()); });
  put(upstream, 'vercel.json', read(upstream, 'vercel.json').replace('"0 4 * * *"', '"15 4 * * *"'));
  release('1.2.0');
  put(client, 'src/custom/more.ts', 'export const more = true;\n');
  editJson(client, 'package.json', p => { (p.dependencies as Record<string, string>)['zz-client'] = '2.0.0'; });
  commit(client, 'Acme: more work');

  const second = runUpgrade();
  check('upgrade 2: exit 0 with no conflicts', second.exitCode === 0 && second.merged && second.conflicts.length === 0, second);
  check('upgrade 2: from 1.1.0 to 1.2.0', second.from === '1.1.0' && second.to === '1.2.0', second);
  check('upgrade 2: only the new migration is listed', same(second.migrationsInRelease, ['20260401000000_more.sql']), second.migrationsInRelease);
  const pkg2 = JSON.parse(read(client, 'package.json'));
  check('upgrade 2: dependencies from both sides',
    same(pkg2.dependencies, { 'acme-sdk': '1.0.0', 'lucide-react': '1.0.0', next: '16.1.0', react: '19.0.0', zod: '4.0.0', 'zz-client': '2.0.0' }), pkg2.dependencies);
  check('upgrade 2: version 1.2.0', pkg2.version === '1.2.0', pkg2.version);
  check('upgrade 2: the release cron change lands, the client cron stays',
    same(JSON.parse(read(client, 'vercel.json')).crons.map((c: { path: string; schedule: string }) => `${c.path} ${c.schedule}`),
      ['/api/b 30 2 * * *', '/api/custom/sync 0 5 * * *', '/api/d 15 4 * * *']), read(client, 'vercel.json'));
  check('upgrade 2: v1.2.0 is an ancestor of HEAD', gitRun(client, ['merge-base', '--is-ancestor', 'v1.2.0', 'HEAD']).code === 0);

  const third = runUpgrade();
  check('upgrade 3: already up to date', third.exitCode === 0 && third.upToDate && !third.merged, third);

  // check:core: a committed core edit and an uncommitted one fail; restoring the release copy passes.
  put(client, 'src/core.ts', 'export const core = 99;\nexport const other = 1;\n');
  commit(client, 'Acme: patch core');
  put(client, 'AGENTS.md', 'edited\n');
  const dirtyCore = checkCore(client);
  check('check:core fails on core edits', dirtyCore.exitCode === 1, dirtyCore.messages);
  check('check:core lists the committed and the uncommitted file', same(dirtyCore.coreFiles, ['AGENTS.md', 'src/core.ts']), dirtyCore.coreFiles);
  check('check:core says what to do', dirtyCore.messages.some(line => /src\/custom/.test(line) && /upstream/.test(line)), dirtyCore.messages);
  git(client, ['checkout', '--', 'AGENTS.md']);
  git(client, ['revert', '--no-edit', 'HEAD']);
  const restored = checkCore(client);
  check('check:core passes once the core file matches the release again', restored.exitCode === 0, restored.messages);

  // check:core: a custom migration that alters a public table fails with the file and statement.
  put(client, 'supabase/migrations/custom/20270501000000_bad.sql', 'CREATE TABLE IF NOT EXISTS pm_custom.ok (id int);\nALTER TABLE pm.tasks ADD COLUMN acme_code text;\n');
  const badSql = checkCore(client);
  check('check:core fails on a custom migration touching public', badSql.exitCode === 1 && badSql.sqlViolations.length === 1, badSql.sqlViolations);
  check('check:core names the file and the statement',
    badSql.sqlViolations[0]?.file === 'supabase/migrations/custom/20270501000000_bad.sql' && /ALTER TABLE pm\.tasks/.test(badSql.sqlViolations[0]?.statement ?? ''), badSql.sqlViolations);
  rmSync(join(client, 'supabase/migrations/custom/20270501000000_bad.sql'));

  // A real conflict in a core file: aborted cleanly, exit 2, the file listed, nothing changed.
  put(upstream, 'src/core.ts', 'export const core = 4;\nexport const other = 1;\n');
  release('1.3.0');
  put(client, 'src/core.ts', 'export const core = 42;\nexport const other = 1;\n');
  commit(client, 'Acme: patch core again');
  const before = git(client, ['rev-parse', 'HEAD']);
  const summaryFile = join(tmp, 'summary.json');
  const cli = runCli(['--skip-checks', '--upstream', upstream, '--branch', 'update/v1.3.0', '--json', summaryFile]);
  check('conflict: exit code 2', cli.code === 2, cli.output);
  check('conflict: the output lists the file', cli.output.includes('src/core.ts'), cli.output);
  const conflict = JSON.parse(readFileSync(summaryFile, 'utf8')) as UpgradeSummary;
  check('conflict: the JSON summary lists the file and did not merge', same(conflict.conflicts, ['src/core.ts']) && !conflict.merged && conflict.to === '1.3.0', conflict);
  check('conflict: HEAD is unchanged', git(client, ['rev-parse', 'HEAD']) === before);
  check('conflict: no merge in progress and a clean tree',
    gitRun(client, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0 && git(client, ['status', '--porcelain']) === '');
  check('conflict: back on main, the branch removed',
    git(client, ['symbolic-ref', '--short', 'HEAD']) === 'main' && gitRun(client, ['rev-parse', '-q', '--verify', 'refs/heads/update/v1.3.0']).code !== 0);

  // An unexpected error once the merge has started (here: invalid JSON on the install's side) aborts it cleanly.
  git(client, ['revert', '--no-edit', 'HEAD']); // drop the conflicting core edit
  put(client, 'vercel.json', '{ "crons": [ broken\n');
  commit(client, 'Acme: break vercel.json');
  put(upstream, 'src/core.ts', 'export const core = 5;\nexport const other = 1;\n');
  put(upstream, 'vercel.json', read(upstream, 'vercel.json').replace('"15 4 * * *"', '"45 4 * * *"'));
  release('1.4.0');
  const beforeBroken = git(client, ['rev-parse', 'HEAD']);
  const broken = runUpgrade({ branch: 'update/v1.4.0' });
  check('mid-merge error: exit 1 naming the invalid file', broken.exitCode === 1 && /vercel\.json/.test(broken.message) && !broken.merged, broken);
  check('mid-merge error: no merge in progress and a clean tree',
    gitRun(client, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0 && git(client, ['status', '--porcelain']) === '', git(client, ['status', '--porcelain']));
  check('mid-merge error: HEAD unchanged, back on main, the branch removed',
    git(client, ['rev-parse', 'HEAD']) === beforeBroken && git(client, ['symbolic-ref', '--short', 'HEAD']) === 'main' &&
    gitRun(client, ['rev-parse', '-q', '--verify', 'refs/heads/update/v1.4.0']).code !== 0);
  git(client, ['revert', '--no-edit', 'HEAD']);

  // check:core: a core edit made only inside a merge commit (a hand-resolved update) is still caught.
  gitRun(client, ['merge', '-q', '--no-ff', '--no-commit', 'v1.4.0']); // conflicts in vercel.json, resolved by hand below
  git(client, ['checkout', '--theirs', '--', 'vercel.json']);
  // A core file no earlier install commit touched, so only the merge commit carries the edit.
  put(client, '.github/workflows/ci.yml', 'name: CI (Acme)\non: [push, pull_request]\n');
  git(client, ['add', '-A']);
  git(client, ['commit', '-q', '-m', 'Update to v1.4.0 (resolved by hand)']);
  const inMerge = checkCore(client);
  check('check:core fails on a core edit made in a merge commit', inMerge.exitCode === 1 && same(inMerge.coreFiles, ['.github/workflows/ci.yml']), inMerge.coreFiles);

  // A merge the user already has in progress survives a refused upgrade, resolution intact.
  put(upstream, 'src/core.ts', 'export const core = 6;\nexport const other = 1;\n');
  release('1.5.0');
  put(client, 'src/core.ts', 'export const core = 60;\nexport const other = 1;\n');
  commit(client, 'Acme: patch core once more');
  git(client, ['fetch', '-q', '--tags', 'upstream']);
  const started = gitRun(client, ['merge', '-q', '--no-ff', '--no-commit', 'v1.5.0']);
  check('merge in progress: the setup merge conflicts in src/core.ts', started.code !== 0 && /src\/core\.ts/.test(started.stdout + started.stderr), started);
  const resolution = 'export const core = 6; // resolved by hand\nexport const other = 1;\n';
  put(client, 'src/core.ts', resolution);
  git(client, ['add', '--', 'src/core.ts']);
  const refused = runUpgrade();
  check('merge in progress: refused with exit 1', refused.exitCode === 1 && /already in progress/.test(refused.message), refused.message);
  check('merge in progress: MERGE_HEAD is still there', gitRun(client, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0);
  check('merge in progress: the resolution is intact', read(client, 'src/core.ts') === resolution && git(client, ['diff', '--cached', '--name-only']).includes('src/core.ts'));
  git(client, ['merge', '--abort']);

  // No shared history: refused with exit 3 and instructions.
  const orphan = join(tmp, 'orphan');
  mkdirSync(orphan);
  git(orphan, ['init', '-q', '-b', 'main']);
  put(orphan, 'package.json', PACKAGE_V1);
  commit(orphan, 'Copied files');
  const noHistory = upgrade({ root: orphan, skipChecks: true, upstreamUrl: upstream });
  check('no shared history: exit 3 with how to recreate the repo', noHistory.exitCode === 3 && /git clone/.test(noHistory.message), noHistory.message);

  // The source monorepo: both tools say so and do nothing.
  const mono = join(tmp, 'mono');
  put(mono, 'app/package.json', PACKAGE_V1);
  git(mono, ['init', '-q', '-b', 'main']);
  commit(mono, 'Monorepo');
  const monoCheck = checkCore(join(mono, 'app'));
  check('source monorepo: check:core passes and says why', monoCheck.exitCode === 0 && monoCheck.source, monoCheck.messages);
  const monoUpgrade = upgrade({ root: join(mono, 'app'), skipChecks: true, upstreamUrl: upstream });
  check('source monorepo: upgrade does nothing', monoUpgrade.exitCode === 0 && !monoUpgrade.merged && /source install/.test(monoUpgrade.message), monoUpgrade.message);
  check('source monorepo: no upstream remote was added', gitRun(mono, ['remote', 'get-url', 'upstream']).code !== 0);
}

try {
  jsonMergeCases();
  generatedTypesCases();
  rulesCases();
  scenario();
} catch (err) {
  failures.push(`crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
if (failures.length) {
  console.error(`upgrade: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`upgrade: all ${passed} checks passed`);
