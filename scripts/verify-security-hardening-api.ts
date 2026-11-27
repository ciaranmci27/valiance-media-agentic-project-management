/**
 * Security hardening, the API side (break-it round of 2026-11-27), each as
 * the tester reproduced it, over the real routes (withApi, the session
 * routes, supabase-js, a fake PostgREST over PGlite with the full schema):
 * - POST /api/notifications: a guest notifies no one; every notice names a
 *   subject the sender and each recipient can open; a link that is not a
 *   page of that subject is dropped; refusals are audited.
 * - Agents: a guest never reads a context pack; a personal assistant's
 *   preferences are its person's and an Owner's; an agent's current run
 *   shows only to someone who may read its task.
 * - Profiles: avatars, timezones and notification preferences are checked
 *   wherever they are set (members, agents, contacts).
 * - Bodies: a body over the limit is 413 before it is parsed, by its
 *   Content-Length or, without one, while it streams.
 * - A task in a project the key cannot open answers the 404 of a missing
 *   task, never its project id.
 * - Webhooks: an endpoint never receives what its maker could not read.
 * - Assistant keys: only the harness path (assistants.provision) collects a
 *   person's assistant key; an Owner never mints one by hand.
 *
 *   npm run -s test:security-hardening
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { JSON_BODY_LIMIT, readBodyText } from '../src/lib/api/body-limit';
import { ApiError } from '../src/lib/api/errors';
import { avatarUrlSchema, isKnownTimeZone, profileFieldProblem } from '../src/lib/schemas/profile';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-00000000c001', email: 'morgan@example.com' },
  admin: { id: '00000000-0000-4000-8000-00000000c002', email: 'priya@example.com' },
  sam: { id: '00000000-0000-4000-8000-00000000c003', email: 'sam@example.com' },
  jordan: { id: '00000000-0000-4000-8000-00000000c004', email: 'jordan@example.com' },
  guest: { id: '00000000-0000-4000-8000-00000000c005', email: 'casey@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' }));
      return true;
    }
    return false;
  };
}

function installSession(supabaseUrl: string) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const store = {
    getAll: () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-27T00:00:00Z' };
      const session = {
        access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: signedIn.id, email: signedIn.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
        refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp, user,
      };
      return [{ name, value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }];
    },
    get: (key: string) => store.getAll().find((cookie) => cookie.name === key),
    set: () => undefined,
  };
  const nextHeaders = createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> };
  nextHeaders.cookies = async () => store;
}

// ── Pure ─────────────────────────────────────────────────────────────────

/** A body stream that counts the chunks pulled from it (none ahead of a read). */
function countedStream(chunk: Uint8Array, chunks: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

async function pureChecks() {
  const status = (error: unknown) => (error instanceof ApiError ? `${error.statusCode} ${(error.details as Loose)?.reason}` : String(error));

  // Content-Length over the limit: refused before a byte is read.
  const neverRead = countedStream(new Uint8Array(1024), 4096);
  const declared = new Request('http://localhost/x', {
    method: 'POST', body: neverRead.stream, headers: { 'content-length': String(JSON_BODY_LIMIT + 1) }, duplex: 'half',
  } as RequestInit);
  const declaredError = await readBodyText(declared).then(() => null, (error) => error);
  check('body: a Content-Length over 1 MB is 413 body_too_large', status(declaredError) === '413 body_too_large', status(declaredError));
  check('body: ... and nothing of it is read', neverRead.pulled() === 0, neverRead.pulled());

  // No Content-Length (chunked): counted while it streams, cancelled when it passes the limit.
  const chunked = countedStream(new Uint8Array(64 * 1024), 1000);
  const streamed = new Request('http://localhost/x', { method: 'POST', body: chunked.stream, duplex: 'half' } as RequestInit);
  const streamedError = await readBodyText(streamed).then(() => null, (error) => error);
  check('body: a chunked body past 1 MB is 413 body_too_large', status(streamedError) === '413 body_too_large', status(streamedError));
  check('body: ... and reading stops just past the limit (the rest is never pulled)', chunked.pulled() === 17 && chunked.cancelled(), { pulled: chunked.pulled(), cancelled: chunked.cancelled() });

  const small = await readBodyText(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ title: 'Héllo' }) }));
  check('body: a small body reads whole, multi-byte text intact', small === '{"title":"Héllo"}', small);

  // Profile fields.
  check('profile: a made-up timezone is refused', !isKnownTimeZone('Not/AZone'));
  check('profile: real zones pass', isKnownTimeZone('America/Phoenix') && isKnownTimeZone('UTC') && isKnownTimeZone('Europe/London'));
  const avatar = (value: string) => avatarUrlSchema.safeParse(value).success;
  check('profile: a javascript: avatar is refused', !avatar('javascript:alert(document.cookie)'));
  check('profile: data:, vbscript: and //host avatars are refused', !avatar('data:image/svg+xml;base64,PHN2Zz4=') && !avatar('vbscript:msgbox(1)') && !avatar('//evil.test/p.png') && !avatar(' javascript:alert(1)'));
  check('profile: https, a path on the app and empty pass', avatar('https://lh3.googleusercontent.com/a/photo.jpg') && avatar('/api/logo') && avatar(''));
  check('profile: prefs must be an object of booleans', profileFieldProblem({ notification_prefs: 'garbage' }) !== null && profileFieldProblem({ notification_prefs: [true] }) !== null
    && profileFieldProblem({ notification_prefs: { task_comments: 'yes' } }) !== null && profileFieldProblem({ notification_prefs: { task_comments: false } }) === null);
  check('profile: a bad timezone or avatar in an update is named', /timezone/.test(profileFieldProblem({ timezone: 'Not/AZone' }) ?? '') && /avatar/i.test(profileFieldProblem({ avatar: 'javascript:alert(1)' }) ?? ''));
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string, login?: { id: string; email: string }, extra: { delegate_of?: string } = {}) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role, delegate_of) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, login?.email ?? `${name.toLowerCase().replace(/[^a-z]/g, '')}@example.com`, role, extra.delegate_of ?? null]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const perm = (memberId: string, key: string, channel: 'app' | 'api', effect: 'allow' | 'deny') =>
    q('INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [memberId, key, channel, effect]);

  const owner = await member('Morgan', 'owner', LOGINS.owner);
  const admin = await member('Priya', 'admin', LOGINS.admin);
  const sam = await member('Sam', 'member', LOGINS.sam);
  const jordan = await member('Jordan', 'member', LOGINS.jordan);
  const guest = await member('Casey', 'guest', LOGINS.guest);
  const forge = await member('Forge', 'agent');
  const samAssistant = await member("Sam's Assistant", 'agent', undefined, { delegate_of: sam });

  // Nobody but the Owner reads every project; Jordan reads only tasks assigned to him.
  for (const m of [admin, sam, jordan]) {
    for (const channel of ['app', 'api'] as const) await perm(m, 'projects.read_all', channel, 'deny');
  }
  for (const channel of ['app', 'api'] as const) {
    await perm(jordan, 'tasks.read', channel, 'deny');
    await perm(jordan, 'tasks.read_assigned', channel, 'allow');
    await perm(jordan, 'agents.manage', channel, 'deny');
    await perm(sam, 'agents.manage', channel, 'deny');
  }
  await perm(admin, 'webhooks.manage', 'api', 'allow');

  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const mobile = await project('Mobile app MVP', [forge]);
  const web = await project('Website', [admin, sam, jordan, guest, forge]);
  const task = async (projectId: string, title: string, assignees: string[] = []) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [projectId, title]))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const crash = await task(mobile, 'Crash reporting', [forge]);
  const homepage = await task(web, 'Homepage design', [jordan, guest]);

  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['team.read', 'team.manage', 'tasks.read', 'tasks.create', 'projects.read', 'api_keys.manage_all']),
    forge: await key(forge, ['notifications.send', 'tasks.read', 'projects.read']),
    ownerHarness: await key(owner, ['team.read', 'assistants.provision', 'tasks.read', 'projects.read']),
    sam: await key(sam, ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read']),
    adminHooks: await key(admin, ['webhooks.manage', 'projects.read']),
  };
  return { q, owner, admin, sam, jordan, guest, forge, samAssistant, mobile, web, crash, homepage, keys };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await pureChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', APP_ENCRYPTION_KEY: 'e'.repeat(64), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  try {
    const notifications = await import('../src/app/api/notifications/route');
    const agentContext = await import('../src/app/api/workspace/agents/[id]/context/route');
    const agentsList = await import('../src/app/api/workspace/agents/route');
    const teamMember = await import('../src/app/api/workspace/team-members/[id]/route');
    const v1AgentContext = await import('../src/app/api/v1/agents/[id]/context/route');
    const v1Agent = await import('../src/app/api/v1/agents/[id]/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Task = await import('../src/app/api/v1/tasks/[id]/route');
    const v1Comments = await import('../src/app/api/v1/tasks/[id]/comments/route');
    const v1Hooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const v1AssistantKey = await import('../src/app/api/v1/assistants/[id]/key/route');
    const v1ApiKeys = await import('../src/app/api/v1/api-keys/route');
    const v1Notifications = await import('../src/app/api/v1/notifications/route');
    const announce = await import('../src/app/api/workspace/announce/route');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const session = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, init: RequestInit = {}) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        ...init,
      } as never), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    const notices = (title: string) => s.q<{ user_id: string; link: string | null }>('SELECT user_id, link FROM pm.team_member_notifications WHERE title = $1', [title]);

    // ── 6. Notifications ──────────────────────────────────────────────
    const phishLink = '/oauth/authorize?client_id=pmc_x&redirect_uri=https%3A%2F%2Fevil.test%2Fcb&response_type=code';
    as(LOGINS.guest);
    const guestNotice = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner, s.admin, s.sam], title: 'SECTEST guest: action needed', message: 'Your session expired.', link: phishLink, category: 'task',
    });
    check('notify: a guest notifies no one (the tester\'s repro)', guestNotice.status === 403 && (await notices('SECTEST guest: action needed')).length === 0, guestNotice);
    const guestOnTask = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner, s.sam], title: 'SECTEST guest on a task', link: `/projects/${s.web}`, entity_type: 'task', entity_id: s.homepage, category: 'task_comments',
    });
    check('notify: a guest is refused even about a task they share', guestOnTask.status === 403 && (await notices('SECTEST guest on a task')).length === 0, guestOnTask);

    as(LOGINS.sam);
    const noSubject = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner], title: 'SECTEST nothing', message: 'x', link: '/team', category: 'task',
    });
    check('notify: a notice about nothing is refused', noSubject.status === 403 && (await notices('SECTEST nothing')).length === 0, noSubject);
    const foreign = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner], title: 'SECTEST foreign task', link: `/projects/${s.mobile}`, entity_type: 'task', entity_id: s.crash, category: 'task_comments',
    });
    check('notify: a notice about a task the sender cannot open is refused', foreign.status === 403 && (await notices('SECTEST foreign task')).length === 0, foreign);
    const asMember = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner], title: 'SECTEST fake join', link: '/team', entity_type: 'member', entity_id: s.jordan, category: 'team_members',
    });
    check('notify: only someone who manages the team sends a team notice', asMember.status === 403, asMember);
    const offsite = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner], title: 'SECTEST offsite', link: '//evil.test/cb', entity_type: 'task', entity_id: s.homepage, category: 'task_comments',
    });
    // A link that is not an in-app path is dropped and the notice still goes out (2.0.50 decision); it is never stored.
    const offsiteRows = await notices('SECTEST offsite');
    check('notify: a //host link is dropped, never stored', offsite.status === 200 && offsiteRows.length > 0 && offsiteRows.every((row) => row.link === null), [offsite, offsiteRows]);
    const backslash = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner], title: 'SECTEST backslash', link: '/\\evil.test', entity_type: 'task', entity_id: s.homepage, category: 'task_comments',
    });
    const backslashRows = await notices('SECTEST backslash');
    check('notify: a /\\host link is dropped, never stored', backslash.status === 200 && backslashRows.length > 0 && backslashRows.every((row) => row.link === null), [backslash, backslashRows]);
    const phish = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner, s.jordan, s.admin], title: 'SECTEST comment', link: phishLink, entity_type: 'task', entity_id: s.homepage, category: 'task_comments',
    });
    const phishRows = await notices('SECTEST comment');
    check('notify: a real notice about a task Sam shares is delivered', phish.status === 200 && phishRows.length === 3, [phish, phishRows]);
    check('notify: ... but a link that is not a page of that task is dropped (never the consent page)', phishRows.every((row) => row.link === null), phishRows);
    const real = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner, s.jordan], title: 'SECTEST real link', link: `/projects/${s.web}`, entity_type: 'task', entity_id: s.homepage, category: 'task_comments',
    });
    const realRows = await notices('SECTEST real link');
    check('notify: the app\'s own link (the task\'s project) is kept', real.status === 200 && realRows.length === 2 && realRows.every((row) => row.link === `/projects/${s.web}`), realRows);
    const keyNotice = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.owner, s.admin, s.jordan], title: 'SECTEST key made', link: '/settings/developers#api-keys', entity_type: 'member', entity_id: null, category: 'api_keys',
    });
    const keyRows = await notices('SECTEST key made');
    check('notify: an API key notice reaches only those who look after keys, link kept', keyNotice.status === 200
      && JSON.stringify(keyRows.map((r) => r.user_id).sort()) === JSON.stringify([s.owner, s.admin].sort()) && keyRows.every((r) => r.link === '/settings/developers#api-keys'), keyRows);
    const agentNotice = await v1(v1Notifications.POST, 'POST', '/api/v1/notifications', {}, s.keys.forge, { title: 'SECTEST agent link', message: 'Reconnect now', link: 'https://evil.test/cb' });
    const agentRows = await notices('SECTEST agent link');
    check('notify: an agent key\'s notice keeps no off-app link', agentNotice.status === 201 && agentRows.length > 0 && agentRows.every((row) => row.link === null), [agentNotice, agentRows]);
    const agentPath = await v1(v1Notifications.POST, 'POST', '/api/v1/notifications', {}, s.keys.forge, { title: 'SECTEST agent path', message: 'See it', link: `/projects/${s.web}` });
    const agentPathRows = await notices('SECTEST agent path');
    check('notify: ... an in-app path is kept', agentPath.status === 201 && agentPathRows.length > 0 && agentPathRows.every((row) => row.link === `/projects/${s.web}`), agentPathRows);
    await settle();
    check('notify: refusals are audited', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint = '/api/notifications' AND status_code = 403") >= 4);

    // ── 10. Context packs ─────────────────────────────────────────────
    as(LOGINS.guest);
    const guestPack = await session(agentContext.GET, 'GET', `/api/workspace/agents/${s.forge}/context`, { id: s.forge });
    const guestPersonalPack = await session(agentContext.GET, 'GET', `/api/workspace/agents/${s.samAssistant}/context?format=pack`, { id: s.samAssistant });
    check('pack: a guest never reads an agent\'s context pack (the tester\'s repro)', guestPack.status === 403 && guestPersonalPack.status === 403
      && !guestPack.text.includes('Forge') && !guestPersonalPack.text.includes('preferences'), [guestPack.status, guestPersonalPack.status]);
    as(LOGINS.admin);
    const adminPack = await session(agentContext.GET, 'GET', `/api/workspace/agents/${s.samAssistant}/context?format=pack`, { id: s.samAssistant });
    check('pack: someone setting up a person\'s assistant sees whose it is, not their preferences', adminPack.status === 200
      && adminPack.body?.data?.pack?.works_for?.id === s.sam && adminPack.body.data.pack.works_for.preferences === undefined
      && (adminPack.body.data.pack.omitted ?? []).some((o: Loose) => o.part === 'preferences'), adminPack.body?.data?.pack?.works_for ?? adminPack);
    as(LOGINS.owner);
    const ownerPack = await session(agentContext.GET, 'GET', `/api/workspace/agents/${s.samAssistant}/context?format=pack`, { id: s.samAssistant });
    check('pack: an Owner still sees the preferences', ownerPack.status === 200 && ownerPack.body?.data?.pack?.works_for?.preferences !== undefined, ownerPack.body?.data?.pack?.works_for ?? ownerPack);

    // ── 11. Current runs ──────────────────────────────────────────────
    await s.q("INSERT INTO pm.agent_runs (agent_id, task_id, status, title, cost_usd, tokens_in) VALUES ($1, $2, 'running', 'SECTEST fixing crash reporting', 1.25, 900)", [s.forge, s.crash]);
    as(LOGINS.jordan);
    const jordanList = await session(agentsList.GET, 'GET', '/api/workspace/agents');
    const jordanForge = (jordanList.body?.data?.agents ?? []).find((a: Loose) => a.id === s.forge);
    check('runs: an assigned-only member does not see a run on a task he cannot open (the tester\'s repro)', jordanList.status === 200 && !!jordanForge && jordanForge.current_run === null
      && !jordanList.text.includes('SECTEST fixing crash reporting') && !jordanList.text.includes(s.crash), jordanForge ?? jordanList);
    as(LOGINS.owner);
    const ownerList = await session(agentsList.GET, 'GET', '/api/workspace/agents');
    const ownerForge = (ownerList.body?.data?.agents ?? []).find((a: Loose) => a.id === s.forge);
    check('runs: whoever manages agents still sees it', ownerForge?.current_run?.task_id === s.crash, ownerForge);

    // ── 14 and (a). Profiles and avatars ──────────────────────────────
    as(LOGINS.guest);
    const tz = await session(teamMember.PATCH, 'PATCH', `/api/workspace/team-members/${s.guest}`, { id: s.guest }, { timezone: 'Not/AZone' });
    const prefs = await session(teamMember.PATCH, 'PATCH', `/api/workspace/team-members/${s.guest}`, { id: s.guest }, { notification_prefs: 'garbage' });
    const jsAvatar = await session(teamMember.PATCH, 'PATCH', `/api/workspace/team-members/${s.guest}`, { id: s.guest }, { avatar: 'javascript:alert(document.cookie)' });
    const stored = (await s.q<Loose>('SELECT timezone, avatar, notification_prefs FROM pm.team_members WHERE id = $1', [s.guest]))[0];
    check('profile: a made-up timezone is 422 (the tester\'s repro)', tz.status === 422, tz);
    check('profile: notification_prefs that are not an object is 422', prefs.status === 422, prefs);
    check('profile: a javascript: avatar is 422', jsAvatar.status === 422, jsAvatar);
    check('profile: nothing of them was stored', stored.timezone !== 'Not/AZone' && !String(stored.avatar ?? '').startsWith('javascript') && typeof stored.notification_prefs !== 'string', stored);
    const fine = await session(teamMember.PATCH, 'PATCH', `/api/workspace/team-members/${s.guest}`, { id: s.guest }, { timezone: 'America/Phoenix', notification_prefs: { task_comments: false } });
    check('profile: a real zone and real prefs still save', fine.status === 200 && fine.body?.data?.timezone === 'America/Phoenix', fine);
    as(LOGINS.owner);
    const hire = await session(agentsList.POST, 'POST', '/api/workspace/agents', {}, { name: 'BK avatar', avatar_url: 'javascript:alert(document.cookie)' });
    check('avatar: hiring with a javascript: avatar is 422 (the tester\'s repro)', hire.status === 422 && await count("SELECT count(*)::int AS n FROM pm.team_members WHERE name = 'BK avatar'") === 0, hire);
    const patched = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.forge}`, { id: s.forge }, s.keys.owner, { avatar_url: 'javascript:alert(1)' });
    check('avatar: PATCH /api/v1/agents/{id} refuses a javascript: avatar', patched.status === 422, patched);

    // ── (b). Body size ────────────────────────────────────────────────
    const big = JSON.stringify({ project_id: s.web, title: 'x', description: 'a'.repeat(JSON_BODY_LIMIT + 10) });
    const tooBig = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.sam, big);
    check('body: a v1 body over 1 MB is 413 body_too_large', tooBig.status === 413 && reason(tooBig) === 'body_too_large', tooBig.status);
    const chunks = countedStream(new TextEncoder().encode('a'.repeat(64 * 1024)), 1000);
    const chunked = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.sam, undefined, { body: chunks.stream, duplex: 'half' } as RequestInit);
    check('body: a chunked v1 body past 1 MB is 413 and stops being read', chunked.status === 413 && reason(chunked) === 'body_too_large' && chunks.pulled() === 17, [chunked.status, chunks.pulled()]);
    const sessionBig = await session(agentsList.POST, 'POST', '/api/workspace/agents', {}, JSON.stringify({ name: 'Big', description: 'a'.repeat(JSON_BODY_LIMIT + 10) }));
    check('body: a session body over 1 MB is 413', sessionBig.status === 413, sessionBig.status);
    const noticeBig = await session(notifications.POST, 'POST', '/api/notifications', {}, JSON.stringify({ recipient_ids: [s.owner], title: 'a'.repeat(JSON_BODY_LIMIT + 10), category: 'task' }));
    check('body: the notifications route is capped too', noticeBig.status === 413, noticeBig.status);
    const tasksBefore = await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'x'");
    check('body: nothing was created', tasksBefore === 0, tasksBefore);

    // ── (c). One 404 for missing and out of reach ─────────────────────
    const hidden = await v1(v1Task.GET, 'GET', `/api/v1/tasks/${s.crash}`, { id: s.crash }, s.keys.sam);
    const unknownId = randomUUID();
    const unknown = await v1(v1Task.GET, 'GET', `/api/v1/tasks/${unknownId}`, { id: unknownId }, s.keys.sam);
    check('404: a task in a project the key cannot open answers like an unknown id (the tester\'s repro)', hidden.status === 404 && unknown.status === 404
      && JSON.stringify(hidden.body) === JSON.stringify(unknown.body), [hidden.body, unknown.body]);
    check('404: ... and never names its project', !hidden.text.includes(s.mobile), hidden.text);
    const hiddenComment = await v1(v1Comments.POST, 'POST', `/api/v1/tasks/${s.crash}/comments`, { id: s.crash }, s.keys.sam, { user_id: s.sam, text: 'SECTEST' });
    check('404: the same on a nested task route (comments)', hiddenComment.status === 404 && !hiddenComment.text.includes(s.mobile), hiddenComment);
    const visible = await v1(v1Task.GET, 'GET', `/api/v1/tasks/${s.homepage}`, { id: s.homepage }, s.keys.sam);
    check('404: a task the key opens still reads', visible.status === 200, visible.status);

    // ── (d). Webhooks follow their maker's reach ──────────────────────
    const everyProject = await v1(v1Hooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.adminHooks, { name: 'All', url: 'https://hooks.example.com/a', events: ['task.created'] });
    check('webhooks: an endpoint for every project needs projects.read_all', everyProject.status === 403 && reason(everyProject) === 'project_scope', everyProject);
    const otherProject = await v1(v1Hooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.adminHooks, { name: 'Mobile', url: 'https://hooks.example.com/m', events: ['task.created'], project_ids: [s.mobile] });
    check('webhooks: an endpoint on a project the maker cannot open is refused', otherProject.status === 403 && reason(otherProject) === 'project_scope', otherProject);
    // One made before this check (or straight in the table) for every project, by Priya, who reads only Website.
    const endpoint = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, created_by)
      VALUES ('Legacy', 'https://hooks.example.com/l', 'whsec_test', '{task.created}', $1) RETURNING id`, [s.admin]))[0].id;
    const mobileTask = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'SECTEST mobile secret') RETURNING id", [s.mobile]))[0].id;
    const webTask = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'SECTEST website task') RETURNING id", [s.web]))[0].id;
    const delivered = async (taskId: string) => count(`SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_events e ON e.id = d.webhook_event_id
      WHERE d.endpoint_id = $1 AND e.resource_id = $2`, [endpoint, taskId]);
    check('webhooks: an endpoint never receives an event from a project its maker cannot read', await delivered(mobileTask) === 0, await delivered(mobileTask));
    check('webhooks: ... and still receives the ones it can', await delivered(webTask) === 1, await delivered(webTask));
    // An agent's reach is granted on the API channel only (2.0.49): its endpoints follow that reach too.
    const hookAgent = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('SECTEST hook agent', 'hook-agent@agents.example.com', 'agent') RETURNING id"))[0].id;
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'allow')", [hookAgent]);
    const agentEndpoint = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, created_by)
      VALUES ('Agent', 'https://hooks.example.com/agent', 'whsec_test', '{task.created}', $1) RETURNING id`, [hookAgent]))[0].id;
    const mobileTask2 = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'SECTEST mobile for agent') RETURNING id", [s.mobile]))[0].id;
    const agentGot = await count(`SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_events e ON e.id = d.webhook_event_id
      WHERE d.endpoint_id = $1 AND e.resource_id = $2`, [agentEndpoint, mobileTask2]);
    check('webhooks: an agent whose reach is granted on the API channel still receives its projects\' events', agentGot === 1, agentGot);

    // ── (a). Avatars written straight to the table ────────────────────
    const fails = (sql: string, params: unknown[] = []) => s.q(sql, params).then(() => null, (error: Error) => error.message);
    check('avatar: a direct contacts insert with a javascript: avatar is refused by the database',
      /avatar/i.test(await fails("INSERT INTO pm.contacts (name, avatar_url) VALUES ('SECTEST', 'javascript:alert(1)')") ?? ''));
    check('avatar: a direct team_members change to a data: avatar is refused by the database',
      /avatar/i.test(await fails("UPDATE pm.team_members SET avatar = 'data:image/svg+xml,<svg onload=alert(1)>' WHERE id = $1", [s.guest]) ?? ''));
    check('avatar: https and app paths still save directly', (await fails("UPDATE pm.team_members SET avatar = 'https://lh3.googleusercontent.com/a/p.jpg' WHERE id = $1", [s.guest])) === null
      && (await fails("INSERT INTO pm.contacts (name, avatar_url) VALUES ('SECTEST ok', '/api/logo')")) === null);
    // (A database without the guard answers the checks above as failures, not a crash here.)
    await fails('ALTER TABLE pm.contacts DISABLE TRIGGER contacts_avatar_guard');
    const legacy = (await s.q<{ id: string }>("INSERT INTO pm.contacts (name, avatar_url) VALUES ('SECTEST legacy', 'javascript:old()') RETURNING id"))[0].id;
    await fails('ALTER TABLE pm.contacts ENABLE TRIGGER contacts_avatar_guard');
    check('avatar: a row stored before the guard still takes unrelated changes', (await fails("UPDATE pm.contacts SET name = 'SECTEST legacy 2', avatar_url = avatar_url WHERE id = $1", [legacy])) === null);

    // ── (e). Assistant keys ───────────────────────────────────────────
    const byHand = await v1(v1ApiKeys.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { name: 'Sam assistant', member_id: s.samAssistant, scopes: ['tasks.read'] });
    check('assistant keys: an Owner never mints a person\'s assistant key by hand', byHand.status === 403 && reason(byHand) === 'personal_agent_owner_only', byHand);
    const noProvision = await v1(v1AssistantKey.POST, 'POST', `/api/v1/assistants/${s.samAssistant}/key`, { id: s.samAssistant }, s.keys.owner, { scopes: ['tasks.read'] });
    check('assistant keys: collecting one needs assistants.provision on the key, Owner or not', noProvision.status === 403, noProvision);
    const harness = await v1(v1AssistantKey.POST, 'POST', `/api/v1/assistants/${s.samAssistant}/key`, { id: s.samAssistant }, s.keys.ownerHarness, { scopes: ['tasks.read'] });
    check('assistant keys: the harness key collects it once, narrowed, and it is audited', harness.status === 201
      && (harness.body?.data?.key?.scopes ?? []).every((scope: string) => ['team.read', 'assistants.provision', 'tasks.read', 'projects.read'].includes(scope)), harness);
    await settle();
    check('assistant keys: ... recorded in the audit log', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint = $1", [`/api/v1/assistants/${s.samAssistant}/key`]) === 1);
    const again = await v1(v1AssistantKey.POST, 'POST', `/api/v1/assistants/${s.samAssistant}/key`, { id: s.samAssistant }, s.keys.ownerHarness, { scopes: ['tasks.read'] });
    check('assistant keys: a second collect is 409 key_exists', again.status === 409 && reason(again) === 'key_exists', again);

    // ── Guests still reach the team, through notices the server writes ──
    // A client guest's comment on a shared task is announced: the server
    // composes the notice from the comment and sends it to who can read the task.
    const guestComment = (await s.q<{ id: string }>("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'SECTEST looks great, ship it') RETURNING id",
      [s.homepage, s.guest]))[0].id;
    as(LOGINS.guest);
    const announced = await session(announce.POST, 'POST', '/api/workspace/announce', {}, { kind: 'task_comment', id: guestComment });
    const commentNotices = await s.q<{ user_id: string; link: string | null; message: string }>(
      'SELECT user_id, link, message FROM pm.team_member_notifications WHERE title = $1', ['New comment on "Homepage design"']);
    check('announce: a guest\'s comment reaches the team', announced.status === 200 && commentNotices.some((n) => n.user_id === s.jordan), { announced, commentNotices });
    check('announce: the server writes the notice from the comment', commentNotices.every((n) => n.link === `/projects/${s.web}` && n.message === 'Casey: "SECTEST looks great, ship it"'), commentNotices);
    check('announce: the author is not told of their own comment', !commentNotices.some((n) => n.user_id === s.guest), commentNotices);
    as(LOGINS.sam);
    const notAuthor = await session(announce.POST, 'POST', '/api/workspace/announce', {}, { kind: 'task_comment', id: guestComment });
    check('announce: only the author announces their comment', notAuthor.status === 404, notAuthor);
    const old = (await s.q<{ id: string }>("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'SECTEST old') RETURNING id", [s.homepage, s.sam]))[0].id;
    await s.q("UPDATE pm.task_comments SET created_at = now() - interval '2 hours' WHERE id = $1", [old]);
    const stale = await session(announce.POST, 'POST', '/api/workspace/announce', {}, { kind: 'task_comment', id: old });
    check('announce: an old comment is not announced again', stale.status === 404, stale);
    as(LOGINS.guest);
    await session(announce.POST, 'POST', '/api/workspace/announce', {}, { kind: 'task_comment', id: guestComment, title: 'SECTEST free text', recipient_ids: [s.owner] });
    check('announce: no free text or recipients are taken', (await notices('SECTEST free text')).length === 0);
    as(LOGINS.sam);
    // A guest's file on their project is announced the same way.
    const guestFile = (await s.q<{ id: string }>(`INSERT INTO pm.entity_files (entity_type, entity_id, name, file_url, file_size, mime_type, visibility, uploaded_by)
      VALUES ('project', $1, 'brief.pdf', 'https://example.com/brief.pdf', 1, 'application/pdf', 'internal', $2) RETURNING id`, [s.web, s.guest]))[0].id;
    as(LOGINS.guest);
    const fileAnnounced = await session(announce.POST, 'POST', '/api/workspace/announce', {}, { kind: 'entity_file', id: guestFile });
    const fileNotices = await s.q<{ user_id: string }>('SELECT user_id FROM pm.team_member_notifications WHERE title = $1', ['File attached to project']);
    check('announce: a guest\'s upload reaches the team', fileAnnounced.status === 200 && fileNotices.some((n) => n.user_id === s.sam), { fileAnnounced, fileNotices });
    const stillRefused = await session(notifications.POST, 'POST', '/api/notifications', {}, {
      recipient_ids: [s.sam], title: 'SECTEST guest free notice', message: 'x', link: null, entity_type: 'task', entity_id: s.homepage, category: 'task',
    });
    check('announce: /api/notifications still refuses guests', stillRefused.status === 403, stillRefused);
    as(LOGINS.owner);

    // v1 context route: a guest key (if a guest ever holds team.read on the API) is refused as well.
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.read', 'api', 'allow') ON CONFLICT DO NOTHING", [s.guest]);
    const guestKeySecret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await s.q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Guest key', 'pk_live', $1, $2, $2, '{team.read}', 'scoped')`, [createHash('sha256').update(guestKeySecret).digest('hex'), s.guest]);
    const guestV1Pack = await v1(v1AgentContext.GET, 'GET', `/api/v1/agents/${s.forge}/context`, { id: s.forge }, guestKeySecret);
    check('pack: a guest\'s key is refused on GET /api/v1/agents/{id}/context too', guestV1Pack.status === 403, guestV1Pack);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length > 0) {
    console.error(`Security hardening (API): ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`Security hardening (API): all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
