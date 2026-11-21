import type { ConnectionInfo, ReleaseInfo, UpdateRun, UpdatesState } from '@/lib/updates/types';

/**
 * Development only: /settings/updates?state=<name> shows the screen in one
 * state without GitHub or the server, so each state can be looked at in the
 * browser. Never used in a production build (see UpdatesSection).
 */

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const REPO = 'acme/pm-app';
const RELEASES = 'https://github.com/acme/pm-app/releases';

const R141: ReleaseInfo = {
  version: '1.4.1',
  publishedAt: iso(60 * 24 * 9),
  url: `${RELEASES}/tag/v1.4.1`,
  notes: '### Fixed\n\n- Time entries started at midnight now show on the right day.\n- The client portal remembers the last tab you opened.\n',
  breaking: false,
  hasMigrations: false,
};

const R150: ReleaseInfo = {
  version: '1.5.0',
  publishedAt: iso(60 * 26),
  url: `${RELEASES}/tag/v1.5.0`,
  notes: [
    '## [1.5.0] - 2026-11-19',
    '',
    '### Breaking',
    '',
    '- Webhook payloads now send amounts in cents. If you read `amount` in your own code, divide by 100.',
    '',
    '### Added',
    '',
    '- **Settings > Updates**: see new versions and install them from the app.',
    '- Leads can be [imported from a CSV](https://example.com/docs) with a preview first.',
    '',
    '### Database',
    '',
    '- Adds a `lead_imports` table. Nothing existing changes.',
    '',
    '### Fixed',
    '',
    '- The inbox no longer jumps when a new email arrives.',
  ].join('\n'),
  breaking: true,
  hasMigrations: true,
};

const connected: ConnectionInfo = { status: 'connected', repo: REPO, defaultBranch: 'main', missing: [], message: null };

const base: UpdatesState = {
  role: 'install',
  current: '1.4.0',
  latest: R150,
  pending: [R141, R150],
  checkedAt: iso(5),
  releasesError: null,
  connection: connected,
  run: null,
};

const run = (patch: Partial<UpdateRun>): UpdateRun => ({
  version: '1.5.0',
  stage: 'preparing',
  workflowRunUrl: 'https://github.com/acme/pm-app/actions/runs/1',
  pullRequestUrl: 'https://github.com/acme/pm-app/pull/42',
  pullRequestNumber: 42,
  headSha: 'abc1234',
  previewUrl: 'https://pm-app-git-core-update-acme.vercel.app',
  checks: [],
  conflictFiles: [],
  hasMigrations: true,
  updatedAt: iso(1),
  ...patch,
});

const passed = [
  { name: 'Type-check', state: 'pass' as const, detail: null },
  { name: 'Core check', state: 'pass' as const, detail: null },
  { name: 'Tests', state: 'pass' as const, detail: null },
];

const notConnected = (status: ConnectionInfo['status'], message: string, extra: Partial<ConnectionInfo> = {}): UpdatesState => ({
  ...base,
  connection: { status, repo: REPO, defaultBranch: 'main', missing: [], message, ...extra },
});

/** Each named state; `loading`, `error` and `demo` are handled by the screen itself. */
export const UPDATE_FIXTURES: Record<string, UpdatesState> = {
  up_to_date: { ...base, current: '1.5.0', pending: [] },
  releases_error: { ...base, current: '1.5.0', pending: [], latest: null, releasesError: 'GitHub is rate limiting requests. Try again in a few minutes.' },
  source: { ...base, role: 'source', current: '1.5.0', pending: [], connection: null },
  not_configured: {
    ...base,
    connection: { status: 'not_configured', repo: null, defaultBranch: null, missing: [], message: 'Add PM_GITHUB_TOKEN and PM_GITHUB_REPO in your host to connect.' },
  },
  token_invalid: notConnected('token_invalid', 'GitHub refused the token.'),
  repo_unreachable: notConnected('repo_unreachable', 'The token can\'t open acme/pm-app.'),
  missing_permissions: notConnected('missing_permissions', 'The token is missing 2 permissions.', { missing: ['Workflows', 'Secrets'] }),
  workflow_missing: notConnected('workflow_missing', 'The update workflow isn\'t in your code yet.'),
  merge_commits_disabled: notConnected('merge_commits_disabled', 'Your repository doesn\'t allow merge commits.'),
  secret_missing: notConnected('secret_missing', 'Connected. One last step: finish setup.'),
  available: base,
  available_one: { ...base, current: '1.4.1', pending: [R150] },
  preparing: { ...base, run: run({ stage: 'preparing' }) },
  checks_running: { ...base, run: run({ stage: 'preparing', checks: [passed[0], { name: 'Core check', state: 'running', detail: null }, { name: 'Tests', state: 'running', detail: null }] }) },
  conflict: { ...base, run: run({ stage: 'conflict', conflictFiles: ['src/components/layout/Sidebar.tsx', 'src/app/(protected)/dashboard/page.tsx'] }) },
  no_shared_history: { ...base, run: run({ stage: 'no_shared_history' }) },
  checks_failed: {
    ...base,
    run: run({
      stage: 'checks_failed',
      checks: [passed[0], { name: 'Core check', state: 'pass', detail: null }, { name: 'Tests', state: 'fail', detail: 'src/custom/leads.test.ts: expected 3 rows, got 2' }],
    }),
  },
  failed: { ...base, run: run({ stage: 'failed' }) },
  ready: { ...base, run: run({ stage: 'ready', checks: passed }) },
  ready_no_preview: { ...base, run: run({ stage: 'ready', checks: passed, previewUrl: null, hasMigrations: false }) },
  waiting_approval: { ...base, run: run({ stage: 'waiting_approval', checks: passed }) },
  applying: { ...base, run: run({ stage: 'applying', checks: passed }) },
  applied: { ...base, run: run({ stage: 'applied', checks: passed }) },
};

export const FIXTURE_NAMES = ['loading', 'error', 'demo', ...Object.keys(UPDATE_FIXTURES)];
