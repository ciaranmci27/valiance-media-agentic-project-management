/**
 * In-app updates: release notes parse into what a release carries; pending
 * releases are the newer ones, oldest first; the connection reports the worst
 * problem first; every update stage derives from GitHub's answers; Apply
 * merges only a ready update, always as a merge commit at the checked head;
 * checks come only from the Actions API and commit statuses (fine-grained
 * tokens have no Checks permission), and a stopped update explains itself
 * through the PM_UPDATE_RESULT line in its job log, read without sending the
 * token to the log host; the routes refuse bad versions, unknown versions,
 * non-owners, cross-site requests, the demo and the source install; the Actions secret is a real
 * sealed box; and both workflow files keep inputs out of shell scripts, never
 * use pull_request_target and pin every action to a commit.
 *
 * GitHub is a stubbed fetch throughout: nothing reaches the network.
 *
 *   npm run -s test:updates
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { UPSTREAM_REPO } from '../src/lib/updates/config';
import { clearConnectionCache, PROBE_REF, PROBE_SECRET_NAME, readConnection } from '../src/lib/updates/connection';
import { createGitHubClient, sealSecret, type FetchLike } from '../src/lib/updates/github';
import { getUpdates, isSameOrigin, postApply, postPrepare, postSetup, type AuditEntry, type UpdatesDeps } from '../src/lib/updates/handlers';
import { clearReleaseCache, parseReleaseNotes, pendingReleases, readReleases, toReleaseInfo } from '../src/lib/updates/releases';
import { canApply, deriveRun, parseHiddenSummary, parseResultMarker } from '../src/lib/updates/run';
import { canUpdate, compareVersions, parseVersion, REQUIRED_TOKEN_PERMISSIONS, type ReleaseInfo, type UpdateRun, type UpdatesState } from '../src/lib/updates/types';
import { DEPLOY_WATCH_MS, deployDeadline, isDeployStalled, runProgress, runSteps, shouldPoll, updatePhase, updateSignal, type RunProgress } from '../src/components/settings/updates/update-phase';

const APP = join(__dirname, '..');
const TOKEN = 'github_pat_TEST_ONLY_never_real_0123456789';
const REPO = 'acme/pm';
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-20T12:00:00Z');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------------------
// A fake GitHub: routes keyed "METHOD /path" (no query), or "METHOD https://host/path"
// for any other host; every call recorded.

interface Answer { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }
type Route = Answer | ((url: URL, init: RequestInit | undefined) => Answer);
interface Call { method: string; path: string; query: string; body: unknown; auth: string | null; init: RequestInit | undefined }

function fakeGitHub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({
      method, path: url.pathname, query: url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers.get('authorization'), init,
    });
    const key = url.origin === 'https://api.github.com' ? `${method} ${url.pathname}` : `${method} ${url.origin}${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const answer = typeof route === 'function' ? route(url, init) : route;
    const status = answer.status ?? 200;
    const body = status === 204 || (status >= 300 && status < 400) ? null : answer.text ?? JSON.stringify(answer.body ?? {});
    return new Response(body, { status, headers: answer.headers });
  };
  return { fetch, calls };
}

const R = (rest: string) => `/repos/${REPO}${rest}`;
const forbidden: Answer = { status: 403, body: { message: 'Resource not accessible by personal access token' } };
const notFound: Answer = { status: 404, body: { message: 'Not Found' } };

/** Git forbids ".." and "~" in a ref, so GitHub can never find or create one. */
const impossibleRef = (ref: unknown) => typeof ref === 'string' && (ref.includes('..') || ref.includes('~'));
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => (typeof init?.body === 'string' ? JSON.parse(init.body) : {});

/**
 * A workflow dispatch as GitHub answers it once the token passed the Actions
 * permission check: 422 for a ref that cannot exist or a missing required
 * input, `valid` otherwise.
 */
function dispatchRoute(valid: () => Answer): Route {
  return (_url, init) => {
    const body = bodyOf(init) as { ref?: unknown; inputs?: { version?: unknown } };
    if (impossibleRef(body.ref)) return { status: 422, body: { message: `No ref found for: ${String(body.ref)}` } };
    if (!body.inputs?.version) return { status: 422, body: { message: "Required input 'version' not provided" } };
    return valid();
  };
}

/** The write probe for each Read and write permission the connection proves, keyed like a fake route. */
const WRITE_PROBES = {
  Contents: `POST ${R('/git/refs')}`,
  'Pull requests': `POST ${R('/pulls')}`,
  Actions: `POST ${R('/actions/workflows/core-update.yml/dispatches')}`,
  Secrets: `PUT ${R(`/actions/secrets/${PROBE_SECRET_NAME}`)}`,
} as const;
type WritePermission = keyof typeof WRITE_PROBES;

/** GitHub's answers to the write probes for a token with write access: validation errors, nothing created. */
function writeAccessRoutes(): Record<string, Route> {
  return {
    [WRITE_PROBES.Contents]: (_url, init) => (impossibleRef(bodyOf(init).ref) || bodyOf(init).sha === '0'.repeat(40)
      ? { status: 422, body: { message: 'Reference name is invalid' } } : { status: 201, body: {} }),
    [WRITE_PROBES['Pull requests']]: (_url, init) => (impossibleRef(bodyOf(init).head)
      ? { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } } : { status: 201, body: {} }),
    [WRITE_PROBES.Actions]: dispatchRoute(() => ({ status: 204 })),
    [WRITE_PROBES.Secrets]: { status: 422, body: { message: 'Secret names must not start with GITHUB_.' } },
  };
}

/** A token with these permissions at Read-only: every write is refused before GitHub reads the input. */
const readOnly = (...names: WritePermission[]): Record<string, Route> => Object.fromEntries(names.map((name) => [WRITE_PROBES[name], forbidden]));

/** A repo the token fully reaches, with the workflow, merge commits and the secret. */
function connectedRoutes(): Record<string, Route> {
  return {
    ...writeAccessRoutes(),
    [`GET ${R('')}`]: { body: { default_branch: 'main', allow_merge_commit: true } },
    [`GET ${R('/commits')}`]: { body: [] },
    [`GET ${R('/pulls')}`]: { body: [] },
    [`GET ${R('/actions/workflows')}`]: { body: { workflows: [] } },
    [`GET ${R('/actions/secrets/public-key')}`]: { body: { key_id: 'k1', key: Buffer.alloc(32, 1).toString('base64') } },
    [`GET ${R('/commits/main/status')}`]: { body: { statuses: [] } },
    [`GET ${R('/deployments')}`]: { body: [] },
    [`GET ${R('/contents/.github/workflows/core-update.yml')}`]: { body: { name: 'core-update.yml' } },
    [`GET ${R('/actions/workflows/core-update.yml')}`]: { body: { state: 'active' } },
    [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: { body: { name: 'PM_UPDATE_TOKEN' } },
  };
}

const ENV = { PM_GITHUB_TOKEN: TOKEN, PM_GITHUB_REPO: REPO };

// ---------------------------------------------------------------------------

const CHANGELOG_SECTION = readFileSync(join(APP, 'CHANGELOG.md'), 'utf8').split(/^## /m).find((part) => part.startsWith('1.0.0')) ?? '';

function notesCases() {
  const full = parseReleaseNotes(`## 1.0.0\n\n${CHANGELOG_SECTION}`);
  check('notes: the real 1.0.0 section is breaking and has migrations', full.breaking && full.hasMigrations, full);
  check('notes: no sections, nothing flagged', JSON.stringify(parseReleaseNotes('Just words.')) === JSON.stringify({ breaking: false, hasMigrations: false }));
  const empty = parseReleaseNotes('### Added\n\n- A thing\n\n### Database\n\n<!-- none -->\n\n### Breaking\n\n');
  check('notes: empty or comment-only sections do not count', !empty.breaking && !empty.hasMigrations, empty);
  const crlf = parseReleaseNotes('### Database\r\n\r\n- 2026_x.sql\r\n### Changed\r\n- y');
  check('notes: CRLF and case-insensitive headings', crlf.hasMigrations && !crlf.breaking, crlf);
  const nested = parseReleaseNotes('### Added\n- a\n## 0.9.0\n### Breaking changes\n- move files');
  check('notes: "Breaking changes" heading counts', nested.breaking, nested);
  const db = parseReleaseNotes('### Added\n- mentions Database and Breaking in text\n');
  check('notes: words in other sections do not count', !db.breaking && !db.hasMigrations, db);

  const info = toReleaseInfo({ tag_name: 'v1.4.0', body: '### Database\n- x.sql', html_url: 'https://github.com/x/y/releases/tag/v1.4.0', published_at: '2026-11-01T00:00:00Z' });
  check('release: tag to version, notes flags', info?.version === '1.4.0' && info.hasMigrations && !info.breaking && info.url.startsWith('https://github.com/'), info);
  check('release: drafts skipped', toReleaseInfo({ tag_name: 'v1.5.0', draft: true }) === null);
  check('release: prereleases skipped', toReleaseInfo({ tag_name: 'v1.5.0', prerelease: true }) === null);
  check('release: non-version tags skipped', toReleaseInfo({ tag_name: 'nightly' }) === null && toReleaseInfo({ tag_name: 'v1.5.0-rc.1' }) === null);
  const unsafe = toReleaseInfo({ tag_name: 'v1.5.0', html_url: 'javascript:alert(1)' });
  check('release: a non-https link is replaced', unsafe?.url === `https://github.com/${UPSTREAM_REPO}/releases/tag/v1.5.0`, unsafe?.url);
}

function versionCases() {
  check('version: v prefix dropped, zeros normalized', parseVersion('v01.4.0') === '1.4.0' && parseVersion(' 1.4.0 ') === '1.4.0');
  for (const bad of ['1.4', '1.4.0.1', '1.4.0-rc1', '1.4.0\nx', '../1.4.0', '12345.0.0', '', 'latest', null, 4, { version: '1.0.0' }]) {
    check(`version: refuses ${JSON.stringify(bad)}`, parseVersion(bad) === null);
  }
  check('compare: numeric, not text', compareVersions('1.10.0', '1.9.0') === 1 && compareVersions('1.0.0', '1.0.0') === 0 && compareVersions('0.9.9', '1.0.0') === -1);
  const releases = ['1.2.0', '1.10.0', '1.0.0', '1.3.0', '0.9.0'].map((version) => ({ version } as ReleaseInfo));
  check('pending: newer only, oldest first', pendingReleases(releases, '1.2.0').map((r) => r.version).join(',') === '1.3.0,1.10.0');
  check('pending: none when current is newest', pendingReleases(releases, '1.10.0').length === 0);
}

async function releaseListCases() {
  const ok = fakeGitHub({
    [`GET /repos/${UPSTREAM_REPO}/releases`]: { body: [
      { tag_name: 'v1.0.0', body: '' }, { tag_name: 'v1.2.0', body: '### Breaking\n- x' }, { tag_name: 'v1.1.0', draft: true },
    ], headers: { date: 'Fri, 20 Nov 2026 10:00:00 GMT' } },
  });
  const list = await readReleases({ fetch: ok.fetch });
  check('releases: newest first, drafts dropped', list.releases.map((r) => r.version).join(',') === '1.2.0,1.0.0' && list.error === null, list);
  check('releases: checkedAt from GitHub Date header', list.checkedAt === '2026-11-20T10:00:00.000Z', list.checkedAt);
  check('releases: read without a token', ok.calls[0].auth === null);
  const cached = ok.calls[0].init as RequestInit & { next?: { revalidate?: number } };
  check('releases: cached six hours', cached.next?.revalidate === 21600 && cached.cache === undefined, cached.next);
  await readReleases({ fetch: ok.fetch, refresh: true });
  check('releases: refresh bypasses the cache', ok.calls[1].init?.cache === 'no-store' && !(ok.calls[1].init as { next?: unknown }).next);

  const limited = fakeGitHub({
    [`GET /repos/${UPSTREAM_REPO}/releases`]: { status: 403, body: { message: 'API rate limit exceeded for 1.2.3.4.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-11-20T13:05:00Z') / 1000) } },
  });
  const limitedList = await readReleases({ fetch: limited.fetch });
  check('releases: rate limit is a readable error with the reset time', /limit/.test(limitedList.error ?? '') && /13:05 UTC/.test(limitedList.error ?? '') && limitedList.releases.length === 0, limitedList.error);
  clearReleaseCache();
  const counted = fakeGitHub({ [`GET /repos/${UPSTREAM_REPO}/releases`]: { body: [{ tag_name: 'v1.4.0', body: '' }] } });
  const first = await readReleases({ fetch: counted.fetch, token: TOKEN, now: () => NOW });
  check('releases: a token is sent as a Bearer header and never cached by Next', counted.calls[0].auth === `Bearer ${TOKEN}` && counted.calls[0].init?.cache === 'no-store'
    && !(counted.calls[0].init as { next?: unknown }).next && first.releases[0]?.version === '1.4.0', counted.calls[0].init);
  await readReleases({ fetch: counted.fetch, token: TOKEN, now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });
  check('releases: the parsed list is kept in memory for six hours per token', counted.calls.length === 1, counted.calls.length);
  await readReleases({ fetch: counted.fetch, token: 'github_pat_OTHER_TEST_TOKEN', now: () => NOW });
  check('releases: another token never shares that list', counted.calls.length === 2 && counted.calls[1].auth === 'Bearer github_pat_OTHER_TEST_TOKEN');
  await readReleases({ fetch: counted.fetch, token: TOKEN, now: () => new Date(NOW.getTime() + 7 * 60 * 60 * 1000) });
  check('releases: after six hours it reads again', counted.calls.length === 3);
  await readReleases({ fetch: counted.fetch, token: TOKEN, refresh: true, now: () => new Date(NOW.getTime() + 7 * 60 * 60 * 1000) });
  check('releases: refresh skips the memory', counted.calls.length === 4);
  clearReleaseCache();
  const refusedToken = fakeGitHub({ [`GET /repos/${UPSTREAM_REPO}/releases`]: (_url, init) => (new Headers(init?.headers).get('authorization')
    ? { status: 401, body: { message: 'Bad credentials' } } : { body: [{ tag_name: 'v1.4.0', body: '' }] }) });
  const fallback = await readReleases({ fetch: refusedToken.fetch, token: TOKEN });
  check('releases: a refused token falls back to the anonymous read', fallback.error === null && fallback.releases.length === 1 && refusedToken.calls[1]?.auth === null, refusedToken.calls.map((c) => c.auth));
  // A fine-grained token scoped to one repo may be refused on the public upstream with 403 or 404.
  for (const [status, message] of [[403, 'Resource not accessible by personal access token'], [404, 'Not Found']] as const) {
    clearReleaseCache();
    const scoped = fakeGitHub({ [`GET /repos/${UPSTREAM_REPO}/releases`]: (_url, init) => (new Headers(init?.headers).get('authorization')
      ? { status, body: { message } } : { body: [{ tag_name: 'v1.4.0', body: '' }] }) });
    const read = await readReleases({ fetch: scoped.fetch, token: TOKEN });
    check(`releases: a ${status} on the token falls back to the anonymous read`, read.error === null && read.releases.length === 1 && scoped.calls[1]?.auth === null, { read, auth: scoped.calls.map((c) => c.auth) });
  }
  clearReleaseCache();
  const limitedToken = fakeGitHub({ [`GET /repos/${UPSTREAM_REPO}/releases`]: { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } } });
  const limitedRead = await readReleases({ fetch: limitedToken.fetch, token: TOKEN });
  check('releases: a rate limit is not retried anonymously', limitedToken.calls.length === 1 && /limit/.test(limitedRead.error ?? ''), limitedToken.calls.length);
  clearReleaseCache();
  const offline = await readReleases({ fetch: async () => { throw new TypeError('fetch failed'); } });
  check('releases: offline is a readable error', /Could not reach GitHub/.test(offline.error ?? ''), offline.error);
}

async function connectionCases() {
  // Each case starts clean: a passed write test is reused per token and repo for a minute.
  const status = async (routes: Record<string, Route>, env: Record<string, string | undefined> = ENV) => {
    clearConnectionCache();
    return (await readConnection({ env, fetch: fakeGitHub(routes).fetch })).info;
  };

  const none = await status({}, {});
  check('connection: env missing first', none.status === 'not_configured' && /PM_GITHUB_TOKEN and PM_GITHUB_REPO/.test(none.message ?? ''), none);
  const onlyToken = await status({}, { PM_GITHUB_TOKEN: TOKEN });
  check('connection: names the missing variable', onlyToken.status === 'not_configured' && /PM_GITHUB_REPO/.test(onlyToken.message ?? '') && !/PM_GITHUB_TOKEN/.test(onlyToken.message ?? ''), onlyToken);
  const badRepo = await status(connectedRoutes(), { PM_GITHUB_TOKEN: TOKEN, PM_GITHUB_REPO: '../evil' });
  check('connection: a malformed repo never reaches a URL', badRepo.status === 'repo_unreachable', badRepo);

  // Every later problem present too: the worst one still wins.
  const everything = (): Record<string, Route> => ({
    ...connectedRoutes(),
    [`GET ${R('/actions/secrets/public-key')}`]: forbidden,
    [`GET ${R('/deployments')}`]: forbidden,
    [`GET ${R('/contents/.github/workflows/core-update.yml')}`]: notFound,
    [`GET ${R('')}`]: { body: { default_branch: 'main', allow_merge_commit: false } },
    [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound,
  });
  const invalid = await status({ ...everything(), [`GET ${R('')}`]: { status: 401, body: { message: 'Bad credentials' } } });
  check('connection: token refused before anything else', invalid.status === 'token_invalid', invalid);
  const unreachable = await status({ ...everything(), [`GET ${R('')}`]: notFound });
  check('connection: repo unreachable (404)', unreachable.status === 'repo_unreachable' && unreachable.repo === REPO, unreachable);
  const unreachable403 = await status({ ...everything(), [`GET ${R('')}`]: forbidden });
  check('connection: repo unreachable (403)', unreachable403.status === 'repo_unreachable', unreachable403);
  const missing = await status(everything());
  check('connection: missing permissions named, before workflow, merge and secret', missing.status === 'missing_permissions'
    && JSON.stringify(missing.missing) === JSON.stringify(['Secrets', 'Deployments']) && /Secrets \(Read and write\), Deployments \(Read-only\)/.test(missing.message ?? ''), missing);
  const allMissing = await status({
    [`GET ${R('')}`]: { body: { default_branch: 'main' } },
  });
  check('connection: each probe maps to a permission name', allMissing.status === 'missing_permissions'
    && JSON.stringify(allMissing.missing) === JSON.stringify(['Contents', 'Pull requests', 'Actions', 'Secrets', 'Commit statuses', 'Deployments']), allMissing.missing);
  const noChecksPermission = await status({ ...connectedRoutes(), [`GET ${R('/commits/main/check-runs')}`]: forbidden });
  check('connection: Checks is never probed (fine-grained tokens have no such permission)', noChecksPermission.status === 'connected', noChecksPermission);
  check('connection: Checks is not a required permission', !REQUIRED_TOKEN_PERMISSIONS.some((permission) => permission.name === 'Checks'));
  const noWorkflow = await status({ ...everything(), [`GET ${R('/actions/secrets/public-key')}`]: connectedRoutes()[`GET ${R('/actions/secrets/public-key')}`], [`GET ${R('/deployments')}`]: { body: [] } });
  check('connection: workflow missing before merge commits and secret', noWorkflow.status === 'workflow_missing' && /core-update\.yml is not on main/.test(noWorkflow.message ?? ''), noWorkflow);
  const disabled = await status({ ...connectedRoutes(), [`GET ${R('/actions/workflows/core-update.yml')}`]: { body: { state: 'disabled_manually' } } });
  check('connection: a switched-off workflow counts as missing', disabled.status === 'workflow_missing' && /switched off/.test(disabled.message ?? ''), disabled);
  const noMerge = await status({ ...connectedRoutes(), [`GET ${R('')}`]: { body: { default_branch: 'main', allow_merge_commit: false } }, [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound });
  check('connection: merge commits off before the secret', noMerge.status === 'merge_commits_disabled', noMerge);
  const noSecret = await status({ ...connectedRoutes(), [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound });
  check('connection: secret missing', noSecret.status === 'secret_missing' && noSecret.defaultBranch === 'main', noSecret);
  const fine = await status(connectedRoutes());
  check('connection: connected', fine.status === 'connected' && fine.message === null && fine.defaultBranch === 'main' && fine.missing.length === 0 && fine.unconfirmed.length === 0, fine);

  // Write access is tested, and a refused test warns without blocking: a token that can read but not write is never connected.
  for (const name of Object.keys(WRITE_PROBES) as WritePermission[]) {
    const readOnlyToken = await status({ ...connectedRoutes(), ...readOnly(name) });
    check(`connection: a token Read-only on ${name} warns about ${name}, never connected and never blocked`, readOnlyToken.status === 'permissions_unconfirmed'
      && canUpdate(readOnlyToken.status) && readOnlyToken.missing.length === 0 && JSON.stringify(readOnlyToken.unconfirmed) === JSON.stringify([name])
      && readOnlyToken.message?.includes(`GitHub refused a test for ${name} (Read and write)`) === true && /fails at its last step/.test(readOnlyToken.message ?? ''), readOnlyToken);
  }
  const twoReadOnly = await status({ ...connectedRoutes(), ...readOnly('Pull requests', 'Secrets') });
  check('connection: every refused write test is named', JSON.stringify(twoReadOnly.unconfirmed) === JSON.stringify(['Pull requests', 'Secrets'])
    && twoReadOnly.message?.includes('Pull requests (Read and write) and Secrets (Read and write)') === true, twoReadOnly);
  check('connection: only connected and the write warning allow updates', canUpdate('connected') && canUpdate('permissions_unconfirmed')
    && !(['not_configured', 'token_invalid', 'repo_unreachable', 'missing_permissions', 'workflow_missing', 'merge_commits_disabled', 'secret_missing'] as const).some((value) => canUpdate(value)));
  const noAccess = await status({ ...connectedRoutes(), ...readOnly('Pull requests'), [`GET ${R('/pulls')}`]: forbidden });
  check('connection: a refused read still blocks, and is not also listed as a write warning', noAccess.status === 'missing_permissions'
    && JSON.stringify(noAccess.missing) === JSON.stringify(['Pull requests']) && noAccess.unconfirmed.length === 0, noAccess);
  const warnedEarly = await status({ ...connectedRoutes(), ...readOnly('Pull requests'), [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound });
  check('connection: a write warning rides along with a worse problem', warnedEarly.status === 'secret_missing' && JSON.stringify(warnedEarly.unconfirmed) === JSON.stringify(['Pull requests']), warnedEarly);
  const noWorkflowFile = await status({ ...connectedRoutes(), [WRITE_PROBES.Actions]: notFound, [`GET ${R('/contents/.github/workflows/core-update.yml')}`]: notFound });
  check('connection: a write probe answered 404 passed the permission check (the workflow is just missing)', noWorkflowFile.status === 'workflow_missing', noWorkflowFile);
  const badRequest = await status({ ...connectedRoutes(), [WRITE_PROBES.Secrets]: { status: 400, body: { message: 'Bad request' } } });
  check('connection: a write probe answered 400 passed the permission check', badRequest.status === 'connected', badRequest);
  const writeLimited = await status({ ...connectedRoutes(), [WRITE_PROBES['Pull requests']]: { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } } });
  check('connection: a rate limit on a write test is untested, never refused, and never blocks', writeLimited.status === 'permissions_unconfirmed'
    && JSON.stringify(writeLimited.unconfirmed) === JSON.stringify(['Pull requests']) && /could not test Pull requests/.test(writeLimited.message ?? '') && !/refused/.test(writeLimited.message ?? ''), writeLimited);
  const writeOutage = await status({ ...connectedRoutes(), [WRITE_PROBES.Contents]: { status: 502, body: { message: 'Bad gateway' } } });
  check('connection: an outage on a write test is untested and never blocks', writeOutage.status === 'permissions_unconfirmed' && /could not test Contents/.test(writeOutage.message ?? ''), writeOutage);
  for (const name of Object.keys(WRITE_PROBES) as WritePermission[]) {
    clearConnectionCache();
    const refusedToken = fakeGitHub({ ...connectedRoutes(), [WRITE_PROBES[name]]: { status: 401, body: { message: 'Bad credentials' } } });
    const refusedInfo = (await readConnection({ env: ENV, fetch: refusedToken.fetch })).info;
    const again = fakeGitHub(connectedRoutes());
    await readConnection({ env: ENV, fetch: again.fetch });
    check(`connection: a 401 on the ${name} write test never counts as having write`, refusedInfo.status === 'token_invalid'
      && again.calls.some((call) => `${call.method} ${call.path}` === WRITE_PROBES[name]), { refusedInfo, resent: again.calls.map((c) => `${c.method} ${c.path}`) });
  }

  // A passed write test is reused for a minute per token and repo, whatever the status, so polls do not resend it.
  clearConnectionCache();
  const pollWorld = fakeGitHub({ ...connectedRoutes(), ...readOnly('Pull requests'), [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound });
  await readConnection({ env: ENV, fetch: pollWorld.fetch });
  const firstWrites = pollWorld.calls.filter((call) => call.method !== 'GET').length;
  await readConnection({ env: ENV, fetch: pollWorld.fetch });
  await readConnection({ env: ENV, fetch: pollWorld.fetch });
  const laterWrites = pollWorld.calls.filter((call) => call.method !== 'GET').slice(firstWrites);
  check('connection: passed write tests are not resent within a minute, even while not connected', firstWrites === 4
    && laterWrites.length === 2 && laterWrites.every((call) => `${call.method} ${call.path}` === WRITE_PROBES['Pull requests']), laterWrites.map((c) => `${c.method} ${c.path}`));
  const otherToken = fakeGitHub(connectedRoutes());
  await readConnection({ env: { ...ENV, PM_GITHUB_TOKEN: 'github_pat_OTHER_TEST_TOKEN' }, fetch: otherToken.fetch });
  check('connection: another token never reuses those passed tests', otherToken.calls.filter((call) => call.method !== 'GET').length === 4);
  clearConnectionCache();
  check('connection: Workflows stays listed but is not checked on save (only a real workflow change reaches that check)',
    REQUIRED_TOKEN_PERMISSIONS.some((p) => p.name === 'Workflows' && p.access === 'Read and write' && !p.checkedOnSave)
    && REQUIRED_TOKEN_PERMISSIONS.filter((p) => p.name !== 'Workflows').every((p) => p.checkedOnSave));

  // Every write probe is invalid by construction: nothing it sends could ever succeed.
  clearConnectionCache();
  const probed = fakeGitHub(connectedRoutes());
  await readConnection({ env: ENV, fetch: probed.fetch });
  const writes = probed.calls.filter((call) => call.method !== 'GET');
  const bodyAt = (key: string) => writes.find((call) => `${call.method} ${call.path}` === key)?.body as Record<string, unknown> | undefined;
  const refBody = bodyAt(WRITE_PROBES.Contents);
  const pullBody = bodyAt(WRITE_PROBES['Pull requests']);
  const dispatchBody = bodyAt(WRITE_PROBES.Actions);
  const secretBody = bodyAt(WRITE_PROBES.Secrets);
  check('probes: one write per Read and write permission, nothing else written', writes.length === 4
    && Object.values(WRITE_PROBES).every((key) => writes.some((call) => `${call.method} ${call.path}` === key)), writes.map((c) => `${c.method} ${c.path}`));
  check('probes: the ref names one git forbids', impossibleRef(PROBE_REF) && PROBE_REF.includes('..') && PROBE_REF.includes('~'));
  check('probes: Contents creates a forbidden ref at an all-zero sha', refBody?.ref === `refs/heads/${PROBE_REF}` && refBody.sha === '0'.repeat(40), refBody);
  check('probes: Pull requests asks between two branches that cannot exist', impossibleRef(pullBody?.head) && impossibleRef(pullBody?.base), pullBody);
  check('probes: Actions dispatches on a ref that cannot exist, without the required version', impossibleRef(dispatchBody?.ref) && dispatchBody?.inputs === undefined, dispatchBody);
  check('probes: Secrets writes a name GitHub forbids with a value that is not base64', PROBE_SECRET_NAME.startsWith('GITHUB_')
    && secretBody?.encrypted_value === '!' && !/^[A-Za-z0-9+/=]+$/.test(String(secretBody?.encrypted_value)), secretBody);
  const limited = await status({ ...connectedRoutes(), [`GET ${R('/deployments')}`]: { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '60' } } });
  check('connection: a rate limit is not a missing permission', limited.status === 'repo_unreachable' && /limit/.test(limited.message ?? ''), limited);
  const timeout = await readConnection({ env: ENV, fetch: (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) as Promise<Response> });
  check('connection: a hung GitHub times out readably', timeout.info.status === 'repo_unreachable', timeout.info);

  const probe = fakeGitHub(connectedRoutes());
  const ctx = await readConnection({ env: ENV, fetch: probe.fetch });
  check('connection: the token never appears in what it returns', !JSON.stringify(ctx.info).includes(TOKEN));
  check('connection: every call carries the token as a Bearer header, never in the URL', probe.calls.every((call) => call.auth === `Bearer ${TOKEN}` && !`${call.path}${call.query}`.includes(TOKEN)));
  check('connection: authenticated reads are never cached', probe.calls.every((call) => call.init?.cache === 'no-store'));
}

async function clientCases() {
  const gh = createGitHubClient({ token: TOKEN, fetch: fakeGitHub({ 'GET /x': { status: 500, body: { message: 'boom' } } }).fetch });
  try {
    await gh.request('/x');
    check('client: a 500 throws', false);
  } catch (error) {
    check('client: errors never carry the token', error instanceof Error && !error.message.includes(TOKEN) && /500/.test(error.message), String(error));
  }
}

// ---------------------------------------------------------------------------
// Run derivation. Only what a fine-grained token reads: Actions runs, jobs and
// job logs, pull requests, commit statuses, deployments. No check runs.

interface RunWorld {
  run?: Record<string, unknown> | null;
  pull?: Record<string, unknown> | null;
  detail?: Record<string, unknown>;
  /** Workflow runs on the pull request's head commit. */
  headRuns?: Record<string, unknown>[];
  /** Jobs per head run id. */
  headJobs?: Record<number, Record<string, unknown>[]>;
  /** The Actions API refuses the head commit's runs. */
  headRunsForbidden?: boolean;
  statuses?: Record<string, unknown>[];
  /** Jobs of the core-update run (id 42). */
  updateJobs?: Record<string, unknown>[];
  /** The failed update job's log, behind GitHub's redirect. */
  log?: string;
  deployments?: Record<string, unknown>[];
  deploymentStatuses?: Record<string, unknown>[];
}

const RELEASE_140 = { version: '1.4.0', publishedAt: '', url: 'https://github.com/x', notes: '', breaking: false, hasMigrations: false } as ReleaseInfo;
const LOG_HOST = 'https://results.blob.example.net';

function runRoutes(world: RunWorld): Record<string, Route> {
  const pull = world.pull ?? null;
  return {
    [`GET ${R('/actions/workflows/core-update.yml/runs')}`]: { body: { workflow_runs: world.run ? [
      { id: 10, display_title: 'Update to v1.3.0', status: 'completed', conclusion: 'failure', created_at: '2026-11-18T00:00:00Z' },
      world.run,
      { id: 1, display_title: 'Update to v1.4.0', status: 'completed', conclusion: 'failure', created_at: '2026-11-19T00:00:00Z' },
    ] : [] } },
    [`GET ${R('/pulls')}`]: (url) => ({ body: pull && url.searchParams.get('head') === 'acme:update/1.4.0' ? [pull] : [] }),
    [`GET ${R('/pulls/7')}`]: { body: { ...(pull ?? {}), mergeable_state: 'clean', ...(world.detail ?? {}) } },
    [`GET ${R('/actions/runs')}`]: (url) => (world.headRunsForbidden ? forbidden
      : { body: { workflow_runs: url.searchParams.get('head_sha') === HEAD ? world.headRuns ?? [] : [] } }),
    [`GET ${R(`/commits/${HEAD}/status`)}`]: { body: { statuses: world.statuses ?? [] } },
    [`GET ${R('/actions/runs/42/jobs')}`]: { body: { jobs: world.updateJobs ?? [{ id: 900, name: 'update', status: 'completed', conclusion: 'failure', steps: [{ name: 'Report the result', conclusion: 'failure' }] }] } },
    ...Object.fromEntries(Object.entries(world.headJobs ?? {}).map(([id, jobs]) => [`GET ${R(`/actions/runs/${id}/jobs`)}`, { body: { jobs } }])),
    [`GET ${R('/actions/jobs/900/logs')}`]: { status: 302, headers: { location: `${LOG_HOST}/logs/900.txt?sig=abc` } },
    [`GET ${LOG_HOST}/logs/900.txt`]: { text: world.log ?? '' },
    [`GET ${R('/deployments')}`]: { body: world.deployments ?? [] },
    [`GET ${R('/deployments/5/statuses')}`]: { body: world.deploymentStatuses ?? [] },
  };
}

const run = (fields: Record<string, unknown> = {}) => ({
  id: 42, display_title: 'Update to v1.4.0', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/acme/pm/actions/runs/42', created_at: '2026-11-20T11:00:00Z', updated_at: '2026-11-20T11:20:00Z', ...fields,
});
const openPull = (fields: Record<string, unknown> = {}) => ({
  number: 7, state: 'open', merged_at: null, html_url: 'https://github.com/acme/pm/pull/7',
  body: 'Notes\n<!-- pm-update-summary {"from":"1.0.0","to":"1.4.0","migrationsInRelease":["2026_a.sql"],"hasMigrations":true} -->',
  created_at: '2026-11-20T11:21:00Z', updated_at: '2026-11-20T11:30:00Z',
  head: { sha: HEAD, ref: 'update/1.4.0', repo: { full_name: 'acme/pm' } }, base: { ref: 'main' }, ...fields,
});
const coreRun = (fields: Record<string, unknown> = {}) => ({
  id: 500, name: 'Core checks', path: '.github/workflows/core-checks.yml', workflow_id: 11, event: 'pull_request',
  status: 'completed', conclusion: 'success', created_at: '2026-11-20T11:22:00Z', ...fields,
});
const passJob = { id: 501, name: 'checks', status: 'completed', conclusion: 'success', steps: [{ name: 'Type-check', conclusion: 'success' }] };
/** core-checks.yml ran on the head commit and passed. */
const passing = (): Pick<RunWorld, 'headRuns' | 'headJobs'> => ({ headRuns: [coreRun()], headJobs: { 500: [passJob] } });

/** A job log as GitHub serves it: every line prefixed with a timestamp. */
const jobLog = (...lines: string[]) => lines.map((line, i) => `2026-11-20T11:10:0${i}.1234567Z ${line}`).join('\n');
const marker = (result: Record<string, unknown>) => `PM_UPDATE_RESULT ${JSON.stringify(result)}`;

async function derive(world: RunWorld, now = NOW, calls?: Call[]): Promise<UpdateRun | null> {
  const github = fakeGitHub(runRoutes(world));
  const gh = createGitHubClient({ token: TOKEN, fetch: github.fetch });
  const result = await deriveRun(gh, REPO, '1.4.0', { defaultBranch: 'main', release: RELEASE_140, now: () => now });
  calls?.push(...github.calls);
  return result;
}

function markerCases() {
  const parsed = parseResultMarker(jobLog('npm ci', '::error title=conflict::src/a.ts', marker({ kind: 'conflict', files: ['src/a.ts', 'src/b.ts'], checks: [], message: 'v1.4.0 conflicts' })));
  check('marker: parsed after the timestamp', parsed?.kind === 'conflict' && parsed.files.join(',') === 'src/a.ts,src/b.ts' && parsed.message === 'v1.4.0 conflicts', parsed);
  const last = parseResultMarker(jobLog(marker({ kind: 'failed', message: 'first' }), marker({ kind: 'checks_failed', checks: [{ name: 'tests', detail: '2 failed\nmore' }] })));
  check('marker: the last line wins, details cut to one line', last?.kind === 'checks_failed' && last.checks[0].name === 'tests' && last.checks[0].detail === '2 failed', last);
  check('marker: none is null', parseResultMarker(jobLog('npm ci', 'done')) === null);
  check('marker: an unknown kind is ignored', parseResultMarker(jobLog(marker({ kind: 'ready' }))) === null);
  const skipBroken = parseResultMarker(jobLog(marker({ kind: 'no_shared_history', message: 'x' }), 'PM_UPDATE_RESULT {not json'));
  check('marker: a broken line falls back to the one before', skipBroken?.kind === 'no_shared_history', skipBroken);
  const hostile = parseResultMarker(jobLog(marker({ kind: 'conflict', files: [42, '', 'ok.ts', 'x'.repeat(900)], checks: 'nope', message: { a: 1 } })));
  check('marker: fields checked one by one', hostile?.files.length === 2 && hostile.files[0] === 'ok.ts' && hostile.files[1].length === 500 && hostile.checks.length === 0 && hostile.message === null, hostile);
  check('marker: CRLF logs', parseResultMarker(`a\r\n2026Z ${marker({ kind: 'failed', message: 'm' })}\r\n`)?.message === 'm');
}

/** Runs core-update.yml's real report script on a summary and parses what it prints. */
function workflowMarkerCases() {
  // A Windows checkout may carry CRLF.
  const text = readFileSync(join(APP, '.github', 'workflows', 'core-update.yml'), 'utf8').replace(/\r\n/g, '\n');
  const script = /node <<'NODE'\n([\s\S]*?)\n\s*NODE\n/.exec(text)?.[1]?.replace(/^ {10}/gm, '');
  check('workflow script: found', !!script);
  if (!script) return;
  const temp = mkdtempSync(join(tmpdir(), 'pm-updates-'));
  try {
    const runScript = (code: number, summary: unknown) => {
      writeFileSync(join(temp, 'upgrade.json'), JSON.stringify(summary));
      const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, RUNNER_TEMP: temp, UPGRADE_CODE: String(code), VERSION: '1.4.0' }, encoding: 'utf8' });
      return { status: result.status, out: result.stdout };
    };
    const odd = 'src/odd %0A name\u2028.ts';
    const files = [odd, ...Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`)];
    const conflict = runScript(2, { conflicts: files, message: 'v1.4.0 conflicts with changes\nline two' });
    const conflictResult = parseResultMarker(conflict.out);
    check('workflow script: conflict prints every file in one marker line', conflict.status === 1 && conflictResult?.kind === 'conflict'
      && conflictResult.files.length === 13 && conflictResult.files[0] === odd && conflictResult.message === 'v1.4.0 conflicts with changes', conflictResult);
    check('workflow script: annotations capped at 10 and escaped', (conflict.out.match(/^::error /gm) ?? []).length === 10 && conflict.out.includes('src/odd %250A name'), conflict.out);
    check('workflow script: the marker is the last line', conflict.out.trim().split('\n').pop()?.startsWith('PM_UPDATE_RESULT ') === true);
    const checksOut = parseResultMarker(runScript(4, { checks: [{ name: 'type-check', ok: false, exitCode: 2, output: 'a\nsrc/x.ts(1,1): error TS1\n' }, { name: 'tests', ok: true }], message: 'Merged v1.4.0, but type-check failed.' }).out);
    check('workflow script: failed checks carry name and last line', checksOut?.kind === 'checks_failed' && checksOut.checks.length === 1 && checksOut.checks[0].name === 'type-check' && checksOut.checks[0].detail === 'src/x.ts(1,1): error TS1', checksOut);
    check('workflow script: no shared history', parseResultMarker(runScript(3, { message: 'v1.4.0 shares no history\nsteps' }).out)?.kind === 'no_shared_history');
    check('workflow script: other errors are failed with the message', parseResultMarker(runScript(1, { message: 'A merge is already in progress.' }).out)?.message === 'A merge is already in progress.');
    check('workflow script: up to date is failed', /up to date/.test(parseResultMarker(runScript(0, { merged: false, upToDate: true }).out)?.message ?? ''));
    const ok = runScript(0, { merged: true });
    check('workflow script: success prints no marker and passes', ok.status === 0 && !ok.out.includes('PM_UPDATE_RESULT'), ok);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function runCases() {
  check('run: nothing started is null', (await derive({})) === null);

  const preparing = await derive({ run: run({ status: 'in_progress', conclusion: null }) });
  check('run: a running workflow is preparing', preparing?.stage === 'preparing' && preparing.workflowRunUrl === 'https://github.com/acme/pm/actions/runs/42', preparing);
  const queued = await derive({ run: run({ status: 'queued', conclusion: null }), pull: openPull() });
  check('run: a queued re-run is preparing even with a pull request', queued?.stage === 'preparing', queued?.stage);

  // Failures, from the result line in the failed job's log.
  const logCalls: Call[] = [];
  const conflict = await derive({ run: run({ conclusion: 'failure' }), log: jobLog('npm ci', marker({ kind: 'conflict', files: ['src/app/page.tsx', 'src/lib/x.ts'], checks: [], message: 'conflicts' })) }, NOW, logCalls);
  check('run: conflict lists the files from the log marker', conflict?.stage === 'conflict'
    && JSON.stringify(conflict.conflictFiles) === JSON.stringify(['src/app/page.tsx', 'src/lib/x.ts']) && conflict.message === 'conflicts', conflict);
  const logApi = logCalls.find((call) => call.path === R('/actions/jobs/900/logs'));
  const logDownload = logCalls.find((call) => call.path === '/logs/900.txt');
  check('run: the log is asked for with the token, without following the redirect', logApi?.auth === `Bearer ${TOKEN}` && logApi.init?.redirect === 'manual', logApi?.init);
  check('run: the token never reaches the log storage host', !!logDownload && logDownload.auth === null && logDownload.query === '?sig=abc', logDownload);
  check('run: no check-run or annotation endpoint is ever called', logCalls.every((call) => !/check-runs|annotations/.test(call.path)));

  const history = await derive({ run: run({ conclusion: 'failure' }), log: jobLog(marker({ kind: 'no_shared_history', message: 'v1.4.0 shares no history' })) });
  check('run: no shared history', history?.stage === 'no_shared_history', history?.stage);
  const wfChecks = await derive({ run: run({ conclusion: 'failure' }), log: jobLog(marker({ kind: 'checks_failed', checks: [{ name: 'type-check', detail: 'src/a.ts(3,1): error TS2304' }, { name: 'tests', detail: '2 failed' }] })) });
  check('run: failed workflow checks named with their reason', wfChecks?.stage === 'checks_failed'
    && wfChecks.checks.length === 2 && wfChecks.checks[0].name === 'type-check' && wfChecks.checks[0].state === 'fail' && /TS2304/.test(wfChecks.checks[0].detail ?? ''), wfChecks?.checks);
  const secretMissing = await derive({ run: run({ conclusion: 'failure' }), log: jobLog(marker({ kind: 'failed', message: 'The PM_UPDATE_TOKEN secret is missing.' })) });
  check('run: a failed marker carries its message', secretMissing?.stage === 'failed' && /PM_UPDATE_TOKEN/.test(secretMissing.message ?? ''), secretMissing);
  const noMarker = await derive({ run: run({ conclusion: 'failure' }), log: jobLog('npm ERR! network'), updateJobs: [{ id: 900, conclusion: 'failure', steps: [{ name: 'Install', conclusion: 'failure' }] }] });
  check('run: no marker is failed, naming the step that stopped', noMarker?.stage === 'failed' && noMarker.message === 'Stopped at: Install', noMarker);
  check('run: a cancelled run is failed', (await derive({ run: run({ conclusion: 'cancelled' }), updateJobs: [] }))?.stage === 'failed');

  // An open pull request: checks from the Actions API and commit statuses.
  const headCalls: Call[] = [];
  const ready = await derive({ run: run(), pull: openPull(), ...passing(), statuses: [{ context: 'Vercel', state: 'success', description: 'Deployment has completed' }],
    deployments: [{ id: 4, environment: 'Production', production_environment: true }, { id: 5, environment: 'Preview' }],
    deploymentStatuses: [{ state: 'success', environment_url: 'https://pm-git-update-140-acme.vercel.app' }] }, NOW, headCalls);
  check('run: core-checks passed on the head commit is ready', ready?.stage === 'ready' && ready.pullRequestNumber === 7 && ready.headSha === HEAD
    && ready.pullRequestUrl === 'https://github.com/acme/pm/pull/7' && ready.checks.length === 2 && ready.checks.every((c) => c.state === 'pass') && canApply(ready), ready);
  check('run: checks named from the workflow, statuses by context', ready?.checks.map((c) => c.name).join(',') === 'Core checks,Vercel', ready?.checks);
  check('run: head checks read through the Actions API', headCalls.some((call) => call.path === R('/actions/runs') && call.query.includes(`head_sha=${HEAD}`)) && headCalls.every((call) => !/check-runs|annotations/.test(call.path)));
  check('run: preview from the non-production deployment', ready?.previewUrl === 'https://pm-git-update-140-acme.vercel.app/', ready?.previewUrl);
  check('run: hasMigrations from the hidden summary', ready?.hasMigrations === true);
  check('run: hidden summary parses', parseHiddenSummary(openPull().body)?.migrationsInRelease?.[0] === '2026_a.sql');

  const unsafePreview = await derive({ run: run(), pull: openPull(), ...passing(), deployments: [{ id: 5, environment: 'Preview' }], deploymentStatuses: [{ state: 'success', environment_url: 'javascript:alert(1)' }] });
  check('run: a non-https preview link is dropped', unsafePreview?.previewUrl === null, unsafePreview?.previewUrl);

  // core-checks.yml not seen yet: preparing for a grace period, then failed so polling stops.
  const fresh = { run: run({ updated_at: '2026-11-20T11:59:00Z' }), pull: openPull({ created_at: '2026-11-20T11:59:30Z' }) };
  const noCore = await derive({ ...fresh, statuses: [{ context: 'Vercel', state: 'success' }] });
  check('run: core-checks not seen yet is preparing, never ready', noCore?.stage === 'preparing' && !canApply(noCore), noCore);
  const empty = await derive({ ...fresh });
  check('run: no checks at all yet is preparing, never ready', empty?.stage === 'preparing' && empty.checks.length === 0 && !canApply(empty), empty);
  const neverRan = await derive({ run: run(), pull: openPull(), statuses: [{ context: 'Vercel', state: 'success' }] });
  check('run: core-checks never ran past the grace period is failed, naming the workflow and what to check', neverRan?.stage === 'failed' && !canApply(neverRan)
    && /\.github\/workflows\/core-checks\.yml/.test(neverRan.message ?? '') && /Actions/.test(neverRan.message ?? '') && /enabled|switched on/i.test(neverRan.message ?? ''), neverRan);
  const refused = await derive({ run: run(), pull: openPull(), headRunsForbidden: true, statuses: [{ context: 'Vercel', state: 'success' }] });
  check('run: Actions refusing the head runs ends failed, never ready', refused?.stage === 'failed' && !canApply(refused), refused);
  const refusedFresh = await derive({ ...fresh, headRunsForbidden: true });
  check('run: Actions refusing the head runs is preparing within the grace period', refusedFresh?.stage === 'preparing', refusedFresh?.stage);
  const slowRunning = await derive({ run: run(), pull: openPull(), headRuns: [coreRun({ status: 'in_progress', conclusion: null })] });
  check('run: core-checks still running long after is preparing, not failed', slowRunning?.stage === 'preparing', slowRunning?.stage);
  const passedCalls: Call[] = [];
  await derive({ run: run(), pull: openPull(), ...passing() }, NOW, passedCalls);
  check('run: a passed workflow run needs no jobs read', !passedCalls.some((call) => call.path === R('/actions/runs/500/jobs')), passedCalls.map((c) => c.path));
  const running = await derive({ run: run(), pull: openPull(), headRuns: [coreRun({ status: 'in_progress', conclusion: null })], headJobs: { 500: [{ id: 501, name: 'checks', status: 'in_progress', conclusion: null }] }, detail: { mergeable_state: 'blocked' } });
  check('run: core-checks running is preparing with the check shown', running?.stage === 'preparing' && running.checks[0]?.state === 'running' && !canApply(running), running);
  const queuedCore = await derive({ run: run(), pull: openPull(), headRuns: [coreRun({ status: 'queued', conclusion: null })] });
  check('run: a queued core-checks run with no jobs yet shows as running', queuedCore?.stage === 'preparing' && queuedCore.checks[0]?.name === 'Core checks' && queuedCore.checks[0].state === 'running', queuedCore?.checks);
  const statusPending = await derive({ run: run(), pull: openPull(), ...passing(), statuses: [{ context: 'Vercel', state: 'pending' }] });
  check('run: a pending status keeps it preparing', statusPending?.stage === 'preparing', statusPending?.stage);

  const coreFailed = await derive({ run: run(), pull: openPull(), headRuns: [coreRun({ conclusion: 'failure' })],
    headJobs: { 500: [{ id: 501, name: 'checks', status: 'completed', conclusion: 'failure', steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Type-check', conclusion: 'failure' }] }] } });
  check('run: core-checks failing is checks_failed, naming the step', coreFailed?.stage === 'checks_failed' && coreFailed.checks[0].detail === 'Failed at: Type-check', coreFailed?.checks);
  const otherWorkflow = await derive({ run: run(), pull: openPull(), headRuns: [coreRun(), { id: 600, name: 'Deploy docs', path: '.github/workflows/docs.yml', workflow_id: 12, status: 'completed', conclusion: 'failure' }],
    headJobs: { 500: [passJob], 600: [{ id: 601, name: 'build', status: 'completed', conclusion: 'failure', steps: [] }, { id: 602, name: 'lint', status: 'completed', conclusion: 'success' }] } });
  check('run: any failing workflow on the head is checks_failed, jobs named per workflow', otherWorkflow?.stage === 'checks_failed'
    && otherWorkflow.checks.some((c) => c.name === 'Deploy docs / build' && c.state === 'fail' && c.detail === 'Ended: failure'), otherWorkflow?.checks);
  const rerun = await derive({ run: run(), pull: openPull(), headRuns: [coreRun({ id: 499, conclusion: 'failure', created_at: '2026-11-20T11:21:30Z' }), coreRun()], headJobs: { 500: [passJob], 499: [{ id: 498, name: 'checks', status: 'completed', conclusion: 'failure' }] } });
  check('run: only the newest run per workflow counts', rerun?.stage === 'ready', rerun);
  const statusFailed = await derive({ run: run(), pull: openPull(), ...passing(), statuses: [{ context: 'Vercel', state: 'failure', description: 'Build failed' }] });
  check('run: a failing commit status is checks_failed', statusFailed?.stage === 'checks_failed' && statusFailed.checks.some((c) => c.name === 'Vercel' && c.detail === 'Build failed'), statusFailed?.checks);

  const approval = await derive({ run: run(), pull: openPull(), ...passing(), detail: { mergeable_state: 'blocked' } });
  check('run: blocked by review is waiting_approval', approval?.stage === 'waiting_approval', approval?.stage);
  const dirty = await derive({ run: run(), pull: openPull(), ...passing(), detail: { mergeable_state: 'dirty' } });
  check('run: a pull request that no longer merges is conflict', dirty?.stage === 'conflict', dirty?.stage);

  const applied = await derive({ run: run({ status: 'in_progress', conclusion: null }), pull: openPull({ state: 'closed', merged_at: '2026-11-20T11:50:00Z' }) });
  check('run: merged is applied, whatever ran after', applied?.stage === 'applied', applied?.stage);
  const forked = await derive({ run: run(), pull: openPull({ head: { sha: HEAD, ref: 'update/1.4.0', repo: { full_name: 'mallory/pm' } } }) });
  check('run: a fork branch of the same name is ignored', forked?.stage === 'failed' && forked.pullRequestNumber === null, forked);
  const noHeadRepo = await derive({ run: run(), pull: openPull({ head: { sha: HEAD, ref: 'update/1.4.0', repo: null } }) });
  check('run: a pull request whose head repo is unknown is ignored', noHeadRepo?.pullRequestNumber === null, noHeadRepo);
  const otherBase = await derive({ run: run(), pull: openPull({ base: { ref: 'staging' } }), ...passing() });
  check('run: a pull request into another branch is ignored', otherBase?.pullRequestNumber === null && otherBase.stage !== 'ready', otherBase);
  check('run: closed without merging starts over', (await derive({ run: run(), pull: openPull({ state: 'closed' }) })) === null);

  const justPushed = await derive({ run: run({ updated_at: '2026-11-20T11:59:00Z' }) });
  check('run: succeeded moments ago with no pull request yet is preparing', justPushed?.stage === 'preparing', justPushed?.stage);
  check('run: succeeded long ago with no pull request is failed', (await derive({ run: run() }))?.stage === 'failed');

  const newerFailure = await derive({ run: run({ conclusion: 'failure', created_at: '2026-11-20T11:40:00Z' }), pull: openPull(), ...passing(),
    log: jobLog(marker({ kind: 'conflict', files: ['src/a.ts'] })) });
  check('run: a failed run newer than the pull request wins', newerFailure?.stage === 'conflict' && newerFailure.pullRequestNumber === 7, newerFailure?.stage);

  check('canApply: ready with no checks seen is refused', !canApply({ stage: 'ready', headSha: HEAD, pullRequestNumber: 7, checks: [] } as unknown as UpdateRun));
}

// ---------------------------------------------------------------------------
// Routes.

interface Harness { deps: UpdatesDeps; audits: AuditEntry[]; calls: Call[] }

function harness(options: { routes?: Record<string, Route>; role?: string; env?: Record<string, string>; current?: string; unauthenticated?: boolean } = {}): Harness {
  clearReleaseCache();
  clearConnectionCache();
  const audits: AuditEntry[] = [];
  const github = fakeGitHub({
    [`GET /repos/${UPSTREAM_REPO}/releases`]: { body: [
      { tag_name: 'v1.4.0', body: '### Database\n- x.sql', html_url: 'https://github.com/r/1.4.0' },
      { tag_name: 'v1.3.0', body: '### Added\n- y', html_url: 'https://github.com/r/1.3.0' },
      { tag_name: 'v1.0.0', body: '', html_url: 'https://github.com/r/1.0.0' },
    ] },
    ...connectedRoutes(),
    ...(options.routes ?? {}),
  });
  return {
    audits,
    calls: github.calls,
    deps: {
      env: { ...ENV, ...(options.env ?? {}) },
      fetch: github.fetch,
      currentVersion: () => options.current ?? '1.0.0',
      now: () => NOW,
      sleep: async () => {},
      authorize: async () => options.unauthenticated
        ? { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
        : { error: null, memberId: 'member-1', role: options.role ?? 'owner' },
      audit: (entry) => audits.push(entry),
    },
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = { origin: 'https://pm.example.com' }) {
  return new NextRequest(`https://pm.example.com/api/workspace/updates/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const get = (query = '') => new NextRequest(`https://pm.example.com/api/workspace/updates${query}`);

async function json(response: Response): Promise<{ status: number; body: { data?: unknown; error?: string } }> {
  return { status: response.status, body: await response.json() };
}

const sent = (h: Harness, method: string, suffix: string) => h.calls.filter((call) => call.method === method && call.path === R(suffix));
/** Workflow dispatches that could start an update: the connection's permission probe never can. */
const dispatches = (h: Harness) => sent(h, 'POST', '/actions/workflows/core-update.yml/dispatches').filter((call) => !impossibleRef((call.body as { ref?: unknown } | undefined)?.ref));
const releaseReads = (h: Harness) => h.calls.filter((call) => call.path.endsWith('/releases'));

async function routeCases() {
  // Guards, for every POST.
  for (const [name, handler] of [['setup', postSetup], ['prepare', postPrepare], ['apply', postApply]] as const) {
    const demo = harness({ env: { DEMO_MODE: 'true' } });
    check(`${name}: demo refused`, (await handler(post(name, { version: '1.4.0' }), demo.deps)).status === 403);
    const cross = harness();
    const crossResponse = await json(await handler(post(name, { version: '1.4.0' }, { origin: 'https://evil.example' }), cross.deps));
    check(`${name}: cross-origin refused`, crossResponse.status === 403 && /Cross-site/.test(crossResponse.body.error ?? ''), crossResponse);
    check(`${name}: no Origin and no Referer refused`, (await handler(post(name, { version: '1.4.0' }, {}), harness().deps)).status === 403);
    check(`${name}: a foreign Referer refused`, (await handler(post(name, { version: '1.4.0' }, { referer: 'https://evil.example/x' }), harness().deps)).status === 403);
    const member = harness({ role: 'admin' });
    const memberResponse = await json(await handler(post(name, { version: '1.4.0' }), member.deps));
    check(`${name}: non-owner refused`, memberResponse.status === 403 && memberResponse.body.error === 'Owner access required', memberResponse);
    check(`${name}: signed out refused`, (await handler(post(name, { version: '1.4.0' }), harness({ unauthenticated: true }).deps)).status === 401);
    const source = harness({ env: { PM_INSTALL_ROLE: 'source' } });
    const sourceResponse = await json(await handler(post(name, { version: '1.4.0' }), source.deps));
    check(`${name}: source install refused plainly`, sourceResponse.status === 409 && /source install/.test(sourceResponse.body.error ?? ''), sourceResponse);
    const layout = harness({ env: { PM_SOURCE_LAYOUT: '1' } });
    const layoutResponse = await json(await handler(post(name, { version: '1.4.0' }), layout.deps));
    check(`${name}: a monorepo-layout build is the source install`, layoutResponse.status === 409 && /source install/.test(layoutResponse.body.error ?? ''), layoutResponse);
    for (const h of [demo, cross, member, source, layout]) {
      check(`${name}: a refused request writes nothing to GitHub`, h.calls.every((call) => call.method === 'GET') && h.audits.length === 0);
    }
  }
  check('origin: a same-host Referer passes', isSameOrigin(post('x', {}, { referer: 'https://pm.example.com/settings/updates' })));

  // GET.
  const install = harness();
  const state = await json(await getUpdates(get(), install.deps));
  const data = state.body.data as UpdatesState;
  check('get: state for an install', state.status === 200 && data.role === 'install' && data.current === '1.0.0' && data.latest?.version === '1.4.0'
    && data.pending.map((r) => r.version).join(',') === '1.3.0,1.4.0' && data.connection?.status === 'connected' && data.run === null && data.releasesError === null, data);
  check('get: an install reads releases with its token, uncached', releaseReads(install).length === 1 && releaseReads(install)[0].auth === `Bearer ${TOKEN}` && releaseReads(install)[0].init?.cache === 'no-store', releaseReads(install).map((c) => c.auth));
  const sourceHarness = harness({ env: { PM_INSTALL_ROLE: 'source' } });
  const source = await json(await getUpdates(get(), sourceHarness.deps));
  const sourceData = source.body.data as UpdatesState;
  check('get: source install reads releases, no connection, no run', source.status === 200 && sourceData.role === 'source' && sourceData.connection === null && sourceData.run === null && sourceData.pending.length === 2, sourceData);
  check('get: the source install reads releases anonymously even with a token set', releaseReads(sourceHarness).every((call) => call.auth === null) && sourceHarness.calls.every((call) => call.path.endsWith('/releases')));
  const layoutData = (await json(await getUpdates(get(), harness({ env: { PM_SOURCE_LAYOUT: '1' } }).deps))).body.data as UpdatesState;
  check('get: PM_SOURCE_LAYOUT=1 is the source install', layoutData.role === 'source' && layoutData.connection === null, layoutData.role);
  check('get: non-owner refused', (await getUpdates(get(), harness({ role: 'member' }).deps)).status === 403);
  check('get: demo refused', (await getUpdates(get(), harness({ env: { NEXT_PUBLIC_DEMO_MODE: 'true' } }).deps)).status === 403);
  const withRun = harness({ routes: runRoutes({ run: run(), pull: openPull(), ...passing() }) });
  const withRunData = (await json(await getUpdates(get('?refresh=1'), withRun.deps))).body.data as UpdatesState;
  check('get: the run follows the version prepared most recently', withRunData.run?.stage === 'ready' && withRunData.run.version === '1.4.0', withRunData.run);
  check('get: ?refresh=1 reads releases fresh', withRun.calls.some((call) => call.path.endsWith('/releases') && call.init?.cache === 'no-store'));
  const firstPoll = withRun.calls.length;
  const polled = (await json(await getUpdates(get(), withRun.deps))).body.data as UpdatesState;
  const pollCalls = withRun.calls.slice(firstPoll);
  const probePaths = [R(''), R('/git/refs'), R(`/actions/secrets/${PROBE_SECRET_NAME}`), R('/commits/main/status'), R('/contents/.github/workflows/core-update.yml'), R('/actions/secrets/PM_UPDATE_TOKEN')];
  check('get: a poll within a minute reuses the connected check', polled.connection?.status === 'connected'
    && !pollCalls.some((call) => probePaths.includes(call.path) || call.method !== 'GET'), pollCalls.map((c) => `${c.method} ${c.path}`));
  check('get: a poll reads the update run list once', pollCalls.filter((call) => call.path === R('/actions/workflows/core-update.yml/runs')).length === 1);
  check('get: a ready poll costs at most 7 GitHub requests', polled.run?.stage === 'ready' && pollCalls.length <= 7, pollCalls.map((c) => `${c.path}${c.query}`));
  const refreshCalls = withRun.calls.length;
  await getUpdates(get('?refresh=1'), withRun.deps);
  check('get: ?refresh=1 checks the connection again', withRun.calls.slice(refreshCalls).some((call) => call.path === R('/actions/secrets/PM_UPDATE_TOKEN')));
  const unconnected = harness({ routes: { [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound } });
  await getUpdates(get(), unconnected.deps);
  const before = unconnected.calls.length;
  await getUpdates(get(), unconnected.deps);
  check('get: a connection that is not connected is never reused', unconnected.calls.slice(before).some((call) => call.path === R('/actions/secrets/PM_UPDATE_TOKEN')));
  check('get: the token never reaches the response', !JSON.stringify(withRunData).includes(TOKEN));

  // Prepare.
  for (const [label, body] of [['bad version', { version: '1.4' }], ['no version', {}], ['not JSON', 'nope'], ['injection', { version: '1.4.0; rm -rf /' }]] as const) {
    const h = harness();
    check(`prepare: ${label} is 400`, (await postPrepare(post('prepare', body), h.deps)).status === 400 && dispatches(h).length === 0);
  }
  const unknown = harness();
  const unknownResponse = await json(await postPrepare(post('prepare', { version: '9.9.9' }), unknown.deps));
  check('prepare: a version that is not a pending release is 400', unknownResponse.status === 400 && /not a newer release/.test(unknownResponse.body.error ?? ''), unknownResponse);
  const older = harness({ current: '1.3.0' });
  check('prepare: an older or current release is 400', (await postPrepare(post('prepare', { version: '1.3.0' }), older.deps)).status === 400);
  const notConnected = harness({ routes: { [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: notFound } });
  const notConnectedResponse = await json(await postPrepare(post('prepare', { version: '1.4.0' }), notConnected.deps));
  check('prepare: requires connected', notConnectedResponse.status === 409 && /Finish setup/.test(notConnectedResponse.body.error ?? '') && dispatches(notConnected).length === 0, notConnectedResponse);
  const busy = harness({ routes: runRoutes({ run: run({ status: 'in_progress', conclusion: null }) }) });
  check('prepare: refuses while one is preparing', (await postPrepare(post('prepare', { version: '1.4.0' }), busy.deps)).status === 409 && dispatches(busy).length === 0);

  let dispatched = false;
  const prepare = harness({ routes: {
    ...runRoutes({}),
    [`POST ${R('/actions/workflows/core-update.yml/dispatches')}`]: dispatchRoute(() => { dispatched = true; return { status: 204 }; }),
    [`GET ${R('/actions/workflows/core-update.yml/runs')}`]: () => ({ body: { workflow_runs: dispatched ? [run({ status: 'queued', conclusion: null })] : [] } }),
  } });
  const prepared = await json(await postPrepare(post('prepare', { version: 'v1.4.0' }), prepare.deps));
  const dispatch = dispatches(prepare);
  check('prepare: dispatches core-update.yml on the default branch with the version', dispatch.length === 1
    && JSON.stringify(dispatch[0].body) === JSON.stringify({ ref: 'main', inputs: { version: '1.4.0' } }), dispatch[0]?.body);
  check('prepare: returns the new run', prepared.status === 200 && (prepared.body.data as UpdateRun).stage === 'preparing' && (prepared.body.data as UpdateRun).workflowRunUrl !== null, prepared);
  check('prepare: audited with before and after', prepare.audits.length === 1 && prepare.audits[0].endpoint === '/api/workspace/updates/prepare'
    && (prepare.audits[0].before_snapshot as { run: unknown }).run === null && !JSON.stringify(prepare.audits).includes(TOKEN), prepare.audits);
  // A refused write test warns but never blocks: the page shows the warning and Prepare still starts.
  for (const name of ['Contents', 'Pull requests', 'Secrets'] as const) {
    let dispatchedHere = false;
    const h = harness({ routes: {
      ...runRoutes({}),
      [WRITE_PROBES.Actions]: dispatchRoute(() => { dispatchedHere = true; return { status: 204 }; }),
      ...readOnly(name),
    } });
    const page = (await json(await getUpdates(get(), h.deps))).body.data as UpdatesState;
    const started = await json(await postPrepare(post('prepare', { version: '1.4.0' }), h.deps));
    check(`prepare: a refused ${name} write test shows the warning and Prepare still starts`, page.connection?.status === 'permissions_unconfirmed'
      && JSON.stringify(page.connection.unconfirmed) === JSON.stringify([name]) && started.status === 200 && dispatchedHere && dispatches(h).length === 1 && h.audits.length === 1, { page: page.connection, started });
  }
  const noReadAccess = harness({ routes: { ...runRoutes({}), [`GET ${R('/pulls')}`]: forbidden, ...readOnly('Pull requests') } });
  const noReadResponse = await json(await postPrepare(post('prepare', { version: '1.4.0' }), noReadAccess.deps));
  check('prepare: a refused read still refuses, as before write tests', noReadResponse.status === 409 && /missing this permission: Pull requests/.test(noReadResponse.body.error ?? '')
    && dispatches(noReadAccess).length === 0 && noReadAccess.audits.length === 0, noReadResponse);
  const refusedDispatch = harness({ routes: { ...runRoutes({}), [`POST ${R('/actions/workflows/core-update.yml/dispatches')}`]: forbidden } });
  const refusedResponse = await json(await postPrepare(post('prepare', { version: '1.4.0' }), refusedDispatch.deps));
  check('prepare: when GitHub refuses the real start, a token without Actions write gets a plain fix', refusedResponse.status === 409 && /Actions: Read and write/.test(refusedResponse.body.error ?? '')
    && refusedDispatch.audits.length === 0, refusedResponse);

  // Apply.
  const notReady: Array<[string, RunWorld]> = [
    ['nothing prepared', {}],
    ['preparing', { run: run({ status: 'in_progress', conclusion: null }) }],
    ['conflict', { run: run({ conclusion: 'failure' }), log: jobLog(marker({ kind: 'conflict', files: ['a.ts'] })) }],
    ['no shared history', { run: run({ conclusion: 'failure' }), log: jobLog(marker({ kind: 'no_shared_history' })) }],
    ['checks failed', { run: run(), pull: openPull(), headRuns: [coreRun({ conclusion: 'failure' })], headJobs: { 500: [{ id: 501, name: 'checks', status: 'completed', conclusion: 'failure' }] } }],
    ['checks running', { run: run(), pull: openPull(), headRuns: [coreRun({ status: 'in_progress', conclusion: null })] }],
    ['core checks never ran', { run: run(), pull: openPull() }],
    ['core checks unreadable', { run: run(), pull: openPull(), headRunsForbidden: true }],
    ['waiting approval', { run: run(), pull: openPull(), ...passing(), detail: { mergeable_state: 'blocked' } }],
    ['into another branch', { run: run(), pull: openPull({ base: { ref: 'staging' } }), ...passing() }],
    ['applied', { run: run(), pull: openPull({ state: 'closed', merged_at: '2026-11-20T11:50:00Z' }) }],
    ['failed', { run: run({ conclusion: 'cancelled' }), updateJobs: [] }],
  ];
  for (const [label, world] of notReady) {
    const h = harness({ routes: { ...runRoutes(world), [`PUT ${R('/pulls/7/merge')}`]: { body: { merged: true } } } });
    const response = await postApply(post('apply', { version: '1.4.0' }), h.deps);
    check(`apply: refuses ${label}`, response.status === 409 && sent(h, 'PUT', '/pulls/7/merge').length === 0, response.status);
  }
  const ready = harness({ routes: { ...runRoutes({ run: run(), pull: openPull(), ...passing() }), [`PUT ${R('/pulls/7/merge')}`]: { body: { merged: true, sha: 'b'.repeat(40) } } } });
  const applied = await json(await postApply(post('apply', { version: '1.4.0' }), ready.deps));
  const merge = sent(ready, 'PUT', '/pulls/7/merge');
  const mergeBody = merge[0]?.body as { merge_method?: string; sha?: string } | undefined;
  check('apply: merges a ready update as a merge commit at the checked head', merge.length === 1 && mergeBody?.merge_method === 'merge' && mergeBody.sha === HEAD, mergeBody);
  check('apply: returns applied', applied.status === 200 && (applied.body.data as UpdateRun).stage === 'applied', applied);
  check('apply: audited', ready.audits.length === 1 && ready.audits[0].endpoint === '/api/workspace/updates/apply' && (ready.audits[0].after_snapshot as { run: UpdateRun }).run.stage === 'applied');
  const unlisted = harness({ routes: { ...runRoutes({ run: run(), pull: openPull(), ...passing() }), [`PUT ${R('/pulls/7/merge')}`]: { body: { merged: true } } } });
  const unlistedResponse = await json(await postApply(post('apply', { version: '1.5.0' }), unlisted.deps));
  check('apply: a version missing from the release list is 400 and never merged', unlistedResponse.status === 400 && /not a newer release/.test(unlistedResponse.body.error ?? '')
    && sent(unlisted, 'PUT', '/pulls/7/merge').length === 0 && releaseReads(unlisted).length === 2, unlistedResponse);
  const protectedBranch = harness({ routes: { ...runRoutes({ run: run(), pull: openPull(), ...passing() }), [`PUT ${R('/pulls/7/merge')}`]: { status: 405, body: { message: 'At least 1 approving review is required by reviewers with write access.' } } } });
  const protectedResponse = await json(await postApply(post('apply', { version: '1.4.0' }), protectedBranch.deps));
  check('apply: a branch protection refusal is waiting_approval with the link', protectedResponse.status === 200
    && (protectedResponse.body.data as UpdateRun).stage === 'waiting_approval' && (protectedResponse.body.data as UpdateRun).pullRequestUrl === 'https://github.com/acme/pm/pull/7', protectedResponse);
  const noMergeCommits = harness({ routes: { ...runRoutes({ run: run(), pull: openPull(), ...passing() }), [`PUT ${R('/pulls/7/merge')}`]: { status: 405, body: { message: 'Merge commits are not allowed on this repository.' } } } });
  check('apply: merge commits switched off is a plain refusal', (await postApply(post('apply', { version: '1.4.0' }), noMergeCommits.deps)).status === 409);
  const moved = harness({ routes: { ...runRoutes({ run: run(), pull: openPull(), ...passing() }), [`PUT ${R('/pulls/7/merge')}`]: { status: 409, body: { message: 'Head branch was modified.' } } } });
  const movedResponse = await json(await postApply(post('apply', { version: '1.4.0' }), moved.deps));
  check('apply: a moved head is refused, not merged blind', movedResponse.status === 409 && /changed since its checks ran/.test(movedResponse.body.error ?? ''), movedResponse);
  check('apply: bad version is 400', (await postApply(post('apply', { version: 'main' }), harness().deps)).status === 400);
  check('apply: a version not newer than current is 400', (await postApply(post('apply', { version: '1.0.0' }), harness().deps)).status === 400);
  check('canApply: only ready with every check passed', !canApply(null)
    && !canApply({ stage: 'waiting_approval', headSha: HEAD, pullRequestNumber: 7, checks: [] } as unknown as UpdateRun)
    && canApply({ stage: 'ready', headSha: HEAD, pullRequestNumber: 7, checks: [{ name: 'c', state: 'pass', detail: null }] } as unknown as UpdateRun));
}

async function secretCases() {
  // libsodium itself, as an independent check that GitHub can open what we seal.
  // Loaded through require: its ESM build is broken in some releases (0.7.16).
  const sodium = createRequire(__filename)('libsodium-wrappers') as typeof import('libsodium-wrappers');
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
  const sealed = await sealSecret(publicKey, TOKEN);
  const opened = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey));
  check('secret: sealed box opens to the same value', opened === TOKEN);
  check('secret: the sealed value does not contain the token', !sealed.includes(TOKEN) && !Buffer.from(sealed, 'base64').toString('utf8').includes(TOKEN));
  try {
    await sealSecret(Buffer.alloc(8).toString('base64'), TOKEN);
    check('secret: a short key is refused', false);
  } catch {
    check('secret: a short key is refused', true);
  }

  // Finish setup end to end: the stored secret opens to PM_GITHUB_TOKEN with the repo's private key.
  let secretStored = false;
  const setup = harness({ routes: {
    [`GET ${R('/actions/secrets/public-key')}`]: { body: { key_id: 'key-7', key: publicKey } },
    [`GET ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: () => (secretStored ? { body: { name: 'PM_UPDATE_TOKEN' } } : notFound),
    [`PUT ${R('/actions/secrets/PM_UPDATE_TOKEN')}`]: () => { secretStored = true; return { status: 201 }; },
  } });
  const response = await json(await postSetup(post('setup', {}), setup.deps));
  const put = sent(setup, 'PUT', '/actions/secrets/PM_UPDATE_TOKEN')[0]?.body as { encrypted_value?: string; key_id?: string } | undefined;
  const stored = put?.encrypted_value ? sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(put.encrypted_value, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey)) : null;
  check('setup: writes PM_UPDATE_TOKEN sealed with the repo key', put?.key_id === 'key-7' && stored === TOKEN, put);
  check('setup: returns the new connection', response.status === 200 && (response.body.data as { status: string }).status === 'connected', response);
  check('setup: never echoes the token (response, audit, request URLs)', !JSON.stringify(response).includes(TOKEN) && !JSON.stringify(setup.audits).includes(TOKEN)
    && setup.calls.every((call) => !`${call.path}${call.query}`.includes(TOKEN)) && !JSON.stringify(put).includes(TOKEN));
  check('setup: audited with before and after', setup.audits.length === 1 && setup.audits[0].endpoint === '/api/workspace/updates/setup'
    && (setup.audits[0].before_snapshot as { connection: { status: string } }).connection.status === 'secret_missing');
  const noRepo = harness({ routes: { [`GET ${R('')}`]: notFound } });
  check('setup: refused when the repo cannot be opened', (await postSetup(post('setup', {}), noRepo.deps)).status === 409 && sent(noRepo, 'PUT', '/actions/secrets/PM_UPDATE_TOKEN').length === 0);
}

/** The lines of each `run:` block in a workflow file. */
function runBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const block = [match[2]];
    if (/^[|>][-+]?\s*$/.test(match[2])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '' && lines[j].search(/\S/) <= indent) break;
        block.push(lines[j]);
      }
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

function workflowCases() {
  for (const file of ['core-update.yml', 'core-checks.yml']) {
    const text = readFileSync(join(APP, '.github', 'workflows', file), 'utf8');
    const blocks = runBlocks(text);
    check(`${file}: has run blocks`, blocks.length >= 3, blocks.length);
    check(`${file}: no \${{ inputs. inside a run block`, blocks.every((block) => !/\$\{\{\s*(github\.event\.)?inputs\./.test(block)));
    check(`${file}: no expressions at all inside run blocks`, blocks.every((block) => !block.includes('${{')), blocks.filter((block) => block.includes('${{')));
    check(`${file}: never pull_request_target`, !/pull_request_target/.test(text));
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
    check(`${file}: uses actions`, uses.length >= 2);
    check(`${file}: every action pinned to a full commit SHA with a version comment`, uses.every((use) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(use[1]) && /#\s*v\d/.test(use[2])), uses.map((use) => use[0].trim()));
    check(`${file}: top-level contents: read`, /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(text));
    check(`${file}: names the same upstream as config.ts`, text.includes(`UPSTREAM_REPO: ${UPSTREAM_REPO}`));
  }
  // gh picks its repo from the git remotes and prefers one named upstream,
  // which npm run upgrade adds (the public repo). Every gh call must name its
  // repo, or a pull request lands on the public repo and the token is refused.
  for (const file of readdirSync(join(APP, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name))) {
    const ghLines = runBlocks(readFileSync(join(APP, '.github', 'workflows', file), 'utf8'))
      .flatMap((block) => block.split('\n'))
      .filter((line) => !line.trim().startsWith('#') && /(^|[\s$(;&|])gh\s+\w/.test(line));
    const unnamed = ghLines.filter((line) => (/\bgh\s+api\b/.test(line)
      ? /\{owner\}|\{repo\}/.test(line) || !/repos\/\$\{?(GITHUB_REPOSITORY|UPSTREAM_REPO)\b/.test(line)
      : !/--repo[ =]"?\$\{?(GITHUB_REPOSITORY|UPSTREAM_REPO)\b/.test(line)));
    check(`${file}: every gh call names its repo (--repo, or an explicit repos/ path for gh api)`, unnamed.length === 0, unnamed.map((line) => line.trim()));
    if (file === 'core-update.yml') check('core-update.yml: the gh check sees its four gh calls', ghLines.length === 4, ghLines.map((line) => line.trim()));
    const ownRepo = ghLines.filter((line) => /\bgh\s+pr\b/.test(line));
    check(`${file}: every gh pr call targets this install's repo, never upstream`, ownRepo.every((line) => /--repo "\$GITHUB_REPOSITORY"/.test(line)), ownRepo.map((line) => line.trim()));
  }
  const update = readFileSync(join(APP, '.github', 'workflows', 'core-update.yml'), 'utf8');
  check('core-update.yml: run-name is the title the app looks for', /^run-name: Update to v\$\{\{ inputs\.version \}\}$/m.test(update));
  check('core-update.yml: validates the version with an anchored bash regex', update.includes('=~ ^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$ ]]'));
  check('core-update.yml: checks out with the update token and full history', /token: \$\{\{ secrets\.PM_UPDATE_TOKEN \}\}\s*\n\s*fetch-depth: 0/.test(update));
  check('core-update.yml: writes the annotation titles run.ts reads', ['conflict', 'conflict_more', 'no_shared_history', 'checks_failed', 'failed'].every((title) => update.includes(`'${title}'`)));
  check('core-update.yml: hides the summary for the app', update.includes('<!-- pm-update-summary ${json} -->'));
  check('core-update.yml: every early stop prints the result line', (update.match(/echo 'PM_UPDATE_RESULT \{"kind":"failed"/g) ?? []).length === 3);
  check('core-update.yml: the token is not left in .git/config', /persist-credentials: false/.test(update));
  const checks = readFileSync(join(APP, '.github', 'workflows', 'core-checks.yml'), 'utf8');
  check('core-checks.yml: runs on pull_request and push', /^\s{2}pull_request:/m.test(checks) && /^\s{2}push:/m.test(checks));
  check('core-checks.yml: runs every check', ['npx tsc --noEmit', 'check:core', 'npx eslint src/custom', 'test:core'].every((step) => checks.includes(step)));
  // Core is linted where it is built; an install's checks never fail on code it cannot edit.
  check('core-checks.yml: lints only the install code', !checks.includes('npm run lint'));
  check('core-checks.yml: concurrency per ref', /group: core-checks-\$\{\{ github\.ref \}\}/.test(checks));
}

// ---------------------------------------------------------------------------
// The Updates screen's state model (update-phase.ts): which screen, which step,
// what the sidebar says, and when the app keeps asking GitHub.

function phaseCases() {
  const now = NOW.getTime();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const release = (version: string): ReleaseInfo => ({
    version, publishedAt: minutesAgo(60 * 24), url: `https://github.com/${REPO}/releases/tag/v${version}`, notes: '', breaking: false, hasMigrations: false,
  });
  const run = (patch: Partial<UpdateRun>): UpdateRun => ({
    version: '1.5.0', stage: 'preparing', workflowRunUrl: null, pullRequestUrl: null, pullRequestNumber: null, headSha: null,
    previewUrl: null, checks: [], conflictFiles: [], hasMigrations: false, updatedAt: minutesAgo(1), ...patch,
  });
  const pass = { name: 'Tests', state: 'pass' as const, detail: null };
  const running = { name: 'Tests', state: 'running' as const, detail: null };
  const state = (patch: Partial<UpdatesState>): UpdatesState => ({
    role: 'install', current: '1.4.0', latest: release('1.5.0'), pending: [release('1.4.1'), release('1.5.0')], checkedAt: null, releasesError: null,
    connection: { status: 'connected', repo: REPO, defaultBranch: 'main', missing: [], unconfirmed: [], message: null }, run: null, database: null, ...patch,
  });
  const steps = (r: UpdateRun, at = now) => Object.values(runSteps(r, at)).join(',');

  // Each stage: the four steps (merge, checks, apply, live), the step shown, and the mood.
  const table: Array<[string, UpdateRun, string, number, RunProgress['mood']]> = [
    ['preparing, merging', run({ stage: 'preparing' }), 'active,next,next,next', 1, 'working'],
    ['preparing, checks running', run({ stage: 'preparing', checks: [running] }), 'done,active,next,next', 2, 'working'],
    ['ready, a check still running', run({ stage: 'ready', checks: [pass, { ...running, name: 'Lint' }] }), 'done,active,next,next', 2, 'working'],
    ['ready', run({ stage: 'ready', checks: [pass] }), 'done,done,turn,next', 3, 'turn'],
    ['waiting for approval', run({ stage: 'waiting_approval', checks: [pass] }), 'done,done,turn,next', 3, 'turn'],
    ['applying', run({ stage: 'applying', checks: [pass] }), 'done,done,active,next', 3, 'working'],
    ['applied, deploying', run({ stage: 'applied', checks: [pass] }), 'done,done,done,active', 4, 'working'],
    ['conflict', run({ stage: 'conflict' }), 'failed,next,next,next', 1, 'failed'],
    ['no shared history', run({ stage: 'no_shared_history' }), 'failed,next,next,next', 1, 'failed'],
    ['checks failed', run({ stage: 'checks_failed', pullRequestNumber: 42 }), 'done,failed,next,next', 2, 'failed'],
    ['failed without a pull request: at the merge', run({ stage: 'failed' }), 'failed,next,next,next', 1, 'failed'],
    ['failed with a pull request: at the checks', run({ stage: 'failed', pullRequestNumber: 42 }), 'done,failed,next,next', 2, 'failed'],
  ];
  for (const [label, r, expected, number, mood] of table) {
    const progress = runProgress(r, now);
    check(`phase steps: ${label}`, steps(r) === expected, steps(r));
    check(`phase progress: ${label} is step ${number}, ${mood}`, progress.number === number && progress.mood === mood && progress.total === 4, progress);
  }

  // The deploy: active until 30 minutes after the merge, then stalled (not active, no poll).
  const merged = run({ stage: 'applied', checks: [pass], updatedAt: minutesAgo(29) });
  const late = run({ stage: 'applied', checks: [pass], updatedAt: minutesAgo(31) });
  check('stalled: 29 minutes after the merge the deploy is still active', steps(merged) === 'done,done,done,active' && !isDeployStalled(merged, now));
  check('stalled: 31 minutes after the merge step 4 is stalled', steps(late) === 'done,done,done,stalled' && isDeployStalled(late, now), steps(late));
  check('stalled: exactly at the deadline it counts as stalled', isDeployStalled(late, Date.parse(late.updatedAt) + DEPLOY_WATCH_MS));
  check('stalled: its mood and place', runProgress(late, now).mood === 'stalled' && runProgress(late, now).number === 4, runProgress(late, now));
  check('stalled: only a merged run stalls', !isDeployStalled(run({ stage: 'applying', updatedAt: minutesAgo(90) }), now) && deployDeadline(run({ stage: 'ready' })) === null);

  // Which screen.
  check('screen: nothing newer is up to date', updatePhase(state({ current: '1.5.0', pending: [] }), now).kind === 'current');
  check('screen: the source install is never asked to update', updatePhase(state({ role: 'source' }), now).kind === 'current');
  const available = updatePhase(state({}), now);
  check('screen: newer releases are available, newest targeted, newest first',
    available.kind === 'available' && available.target.version === '1.5.0' && available.releases.map((r) => r.version).join(',') === '1.5.0,1.4.1', available);
  const updating = updatePhase(state({ run: run({ stage: 'preparing' }) }), now);
  check('screen: a moving run is updating', updating.kind === 'running' && updating.progress.current === 'merge', updating.kind);
  check('screen: a stopped run is failed', updatePhase(state({ run: run({ stage: 'checks_failed', pullRequestNumber: 42 }) }), now).kind === 'failed');
  check('screen: a stopped run for an older release gives way to the newer one', updatePhase(state({ run: run({ stage: 'conflict', version: '1.4.1' }) }), now).kind === 'available');
  check('screen: a merged run still deploying keeps the progress view', updatePhase(state({ run: merged }), now).kind === 'running');
  check('screen: a stalled deploy keeps the progress view', updatePhase(state({ run: late }), now).kind === 'running');
  check('screen: once this app runs the merged version it is up to date', updatePhase(state({ current: '1.5.0', pending: [], run: run({ stage: 'applied' }) }), now).kind === 'current');
  const getting = updatePhase(state({ run: run({ stage: 'preparing', version: '1.4.1' }) }), now);
  check('screen: what you are getting is up to the run\'s version', getting.kind === 'running' && getting.releases.map((r) => r.version).join(',') === '1.4.1', getting);

  // The sidebar's mark.
  check('signal: up to date shows nothing', updateSignal(state({ current: '1.5.0', pending: [] }), now) === null && updateSignal(undefined, now) === null);
  const ready = updateSignal(state({}), now);
  check('signal: a new version is a plain dot', ready?.tone === 'available' && ready.fraction === null && ready.label === '1.5.0 is ready to install', ready);
  const working = updateSignal(state({ run: run({ stage: 'preparing', checks: [running] }) }), now);
  check('signal: updating names the step', working?.tone === 'working' && working.label === 'Updating to 1.5.0, step 2 of 4' && working.fraction === 0.375, working);
  check('signal: ready to apply is the Owner\'s turn', updateSignal(state({ run: run({ stage: 'ready', checks: [pass] }) }), now)?.tone === 'turn');
  check('signal: an approval is the Owner\'s turn', /approval/.test(updateSignal(state({ run: run({ stage: 'waiting_approval', checks: [pass] }) }), now)?.label ?? ''));
  const stopped = updateSignal(state({ run: run({ stage: 'failed', pullRequestNumber: 42 }) }), now);
  check('signal: a stop says where', stopped?.tone === 'failed' && stopped.label === 'Update to 1.5.0 stopped at step 2 of 4', stopped);
  check('signal: deploying is still working', updateSignal(state({ run: merged }), now)?.tone === 'working');
  const stalled = updateSignal(state({ run: late }), now);
  check('signal: a stalled deploy has its own tone and words', stalled?.tone === 'stalled' && /^Deploy taking long/.test(stalled.label), stalled);

  // When the app keeps asking GitHub.
  const polls = (r: UpdateRun | null, patch: Partial<UpdatesState> = {}) => shouldPoll(state({ ...patch, run: r }), now);
  check('poll: nothing to follow, no poll', !polls(null) && !shouldPoll(undefined, now));
  check('poll: preparing and applying poll', polls(run({ stage: 'preparing' })) && polls(run({ stage: 'applying' })));
  check('poll: ready with a check running polls; ready and settled waits for the Owner', polls(run({ stage: 'ready', checks: [running] })) && !polls(run({ stage: 'ready', checks: [pass] })));
  check('poll: waiting for an approval does not poll', !polls(run({ stage: 'waiting_approval', checks: [pass] })));
  check('poll: a stopped run does not poll', !polls(run({ stage: 'checks_failed' })) && !polls(run({ stage: 'conflict' })) && !polls(run({ stage: 'failed' })));
  check('poll: merged, deploying, under 30 minutes polls', polls(merged));
  check('poll: merged 30 minutes ago or more stops (stalled)', !polls(late));
  check('poll: merged and this app already runs that version stops', !polls(run({ stage: 'applied' }), { current: '1.5.0', pending: [] }));
}

async function main() {
  notesCases();
  versionCases();
  await releaseListCases();
  await connectionCases();
  await clientCases();
  markerCases();
  workflowMarkerCases();
  await runCases();
  await routeCases();
  await secretCases();
  workflowCases();
  phaseCases();
}

main()
  .catch((err) => failures.push(`crashed: ${err instanceof Error ? err.stack : String(err)}`))
  .finally(() => {
    if (failures.length) {
      console.error(`updates: ${failures.length} failed, ${passed} passed`);
      for (const failure of failures) console.error(`  FAIL ${failure}`);
      process.exit(1);
    }
    console.log(`updates: all ${passed} checks passed`);
  });
