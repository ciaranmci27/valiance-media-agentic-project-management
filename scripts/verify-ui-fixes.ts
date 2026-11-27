/**
 * The UI fixes' rules (2.0.50), through the real session routes and
 * supabase-js over a fake PostgREST on PGlite with the full schema:
 * - A display name is required and trimmed (Settings > Account, the
 *   workspace route and the v1 schema).
 * - Notifications: links are paths in this app only (kept, stripped or
 *   refused, server side and as the page follows them), and each one says
 *   who sent it, a guest included; the app's own notices say so.
 * - Guests see only the questions and approvals addressed to them (or a
 *   group they are in), in the app's read, the task read and row security.
 * - Time zones: a person's profile zone is the one rule; a profile nobody
 *   set takes the browser's zone once, a chosen zone is kept, and times
 *   format in the zone.
 * - The migration, run twice on the schema before it, matches schema.sql.
 *
 *   npm run -s test:ui-fixes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { checkMemberName, isValidTimeZone } from '../src/lib/member-profile';
import { notificationSender, notificationSenderLabel, safeNotificationLink } from '../src/lib/notifications';
import { browserTimeZone, profileTimeZone, shouldDefaultTimeZone } from '../src/lib/time-zone';
import { formatAgo, formatDateTime, formatDay, formatInZone, formatTime } from '../src/lib/time-format';
import { createNotificationSchema, updateTeamMemberSchema } from '../src/lib/schemas';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const MIGRATION = '20261127001500_ui_fixes.sql';
const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-0000000f0001', email: 'morgan@example.com' },
  guest: { id: '00000000-0000-4000-8000-0000000f0002', email: 'casey@client.example' },
  member: { id: '00000000-0000-4000-8000-0000000f0003', email: 'sam@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (_request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' }));
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
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-24T00:00:00Z' };
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

function pureChecks() {
  const blank = checkMemberName('   ');
  const empty = checkMemberName('');
  const spaced = checkMemberName('  Morgan   Hale ');
  check('name: blank and empty are refused with a plain reason', !blank.ok && !empty.ok && !blank.ok && /Enter a name/.test(blank.ok ? '' : blank.error), [blank, empty]);
  check('name: trimmed, inner spaces kept as one', spaced.ok && spaced.name === 'Morgan Hale', spaced);
  check('name: too long is refused', !checkMemberName('x'.repeat(101)).ok);
  check('v1 schema: a blank name is refused, a padded one trimmed', !updateTeamMemberSchema.safeParse({ name: '   ' }).success
    && updateTeamMemberSchema.safeParse({ name: ' Sam ' }).data?.name === 'Sam');
  check('v1 schema: a time zone must be real', !updateTeamMemberSchema.safeParse({ timezone: 'Mars/Base' }).success
    && updateTeamMemberSchema.safeParse({ timezone: 'America/Phoenix' }).success && isValidTimeZone('UTC') && !isValidTimeZone(''));

  const links: [unknown, string | null][] = [
    ['/projects/abc?tab=tasks', '/projects/abc?tab=tasks'],
    ['/oauth/authorize?redirect_uri=https://evil.test/cb', '/oauth/authorize?redirect_uri=https://evil.test/cb'],
    ['https://evil.test/cb', null],
    ['//evil.test/cb', null],
    ['/\\evil.test', null],
    ['javascript:alert(1)', null],
    ['projects/abc', null],
    ['/tasks\n/x', null],
    ['/' + 'a'.repeat(600), null],
    [null, null],
    [42, null],
  ];
  const wrong = links.filter(([input, want]) => safeNotificationLink(input) !== want);
  check('links: only a path in this app is kept', wrong.length === 0, wrong);
  const parsedLink = (link: unknown) => { const r = createNotificationSchema.safeParse({ title: 'T', message: 'M', link }); return r.success ? r.data.link ?? null : 'refused'; };
  check('v1 notify schema: a URL link is dropped (the notice still goes), a path kept', parsedLink('https://evil.test') === null
    && parsedLink('//evil.test') === null && parsedLink('/my-tasks') === '/my-tasks' && parsedLink(null) === null && parsedLink(undefined) === null,
    [parsedLink('https://evil.test'), parsedLink('//evil.test'), parsedLink('/my-tasks')]);

  const team = [
    { id: 'g', name: 'Casey Brooks', avatar: null, role: 'guest' },
    { id: 'a', name: 'Atlas', avatar: 'https://x/a.png', role: 'agent' },
    { id: 'p', name: 'Sam Lee', avatar: null, role: 'member' },
  ];
  check('sender: a guest says so', notificationSenderLabel(notificationSender({ actor_id: 'g' }, team)) === 'From Casey Brooks (guest)');
  check('sender: an agent says so, with its picture', (() => {
    const s = notificationSender({ actor_id: 'a' }, team);
    return notificationSenderLabel(s) === 'From Atlas (agent)' && s.kind === 'agent' && s.avatar === 'https://x/a.png';
  })());
  check('sender: a person reads by name', notificationSenderLabel(notificationSender({ actor_id: 'p' }, team)) === 'From Sam Lee');
  check('sender: your own action reads as you', notificationSenderLabel(notificationSender({ actor_id: 'p' }, team), 'p') === 'From you');
  check('sender: no actor is the app', notificationSenderLabel(notificationSender({ actor_id: null }, team)) === 'From the app');
  check('sender: an actor the reader cannot see is never the app', notificationSenderLabel(notificationSender({ actor_id: 'hidden' }, team)) === 'From Someone');
  check('sender: the server\'s actor wins over the team list', notificationSenderLabel(notificationSender({ actor_id: 'p', actor: { id: 'p', name: 'Sam L.', avatar: null, role: 'guest' } }, team)) === 'From Sam L. (guest)');

  const browser = 'America/Phoenix';
  check('zone: a set profile zone is used', profileTimeZone({ timezone: 'Europe/London', timezone_set: true }) === 'Europe/London');
  check('zone: a chosen UTC is used', profileTimeZone({ timezone: 'UTC', timezone_set: true }) === 'UTC');
  check('zone: an unset profile uses the browser zone, whatever is stored', profileTimeZone({ timezone: 'Pacific/Chatham', timezone_set: false }) === browserTimeZone()
    && profileTimeZone({ timezone: 'UTC', timezone_set: false }) === browserTimeZone());
  check('zone: a database before the flag reads UTC as unset and any other zone as set', profileTimeZone({ timezone: 'Asia/Tokyo' }) === 'Asia/Tokyo');
  check('zone: first sign-in defaults only an unset profile, once', shouldDefaultTimeZone({ timezone: 'UTC', timezone_set: false }, browser)
    && !shouldDefaultTimeZone({ timezone: 'UTC', timezone_set: true }, browser)
    && !shouldDefaultTimeZone({ timezone: browser, timezone_set: false }, browser)
    && !shouldDefaultTimeZone({ timezone: 'UTC' }, browser) && !shouldDefaultTimeZone(null, browser));

  // 21:26 UTC is 2:26 PM in Phoenix and 9:26 PM in London (winter).
  const at = '2026-11-26T21:26:00Z';
  const now = new Date('2026-11-27T01:00:00Z');
  check('format: times show in the zone given', /2:26/.test(formatTime(at, 'America/Phoenix')) && /9:26/.test(formatTime(at, 'Europe/London')),
    [formatTime(at, 'America/Phoenix'), formatTime(at, 'Europe/London')]);
  check('format: any fields, in the zone', /2:26/.test(formatInZone(at, { hour: 'numeric', minute: '2-digit' }, 'America/Phoenix'))
    && /9:26/.test(formatInZone(at, { hour: 'numeric', minute: '2-digit' }, 'Europe/London')));
  check('format: date and time in the zone', /Nov 26/.test(formatDateTime(at, now, 'America/Phoenix')) && /Nov 26/.test(formatDateTime(at, now, 'Europe/London')));
  // At 01:00 UTC on the 27th it is still the 26th in Phoenix, the 27th in Tokyo.
  check('format: today and yesterday are the person\'s own days', formatAgo('2026-11-26T14:00:00Z', { now, timeZone: 'America/Phoenix' }) === '11 h ago'
    && formatAgo('2026-11-26T14:00:00Z', { now, timeZone: 'Asia/Tokyo' }) === 'Yesterday',
    [formatAgo('2026-11-26T14:00:00Z', { now, timeZone: 'America/Phoenix' }), formatAgo('2026-11-26T14:00:00Z', { now, timeZone: 'Asia/Tokyo' })]);
  check('format: a calendar date is the same day in every zone', formatDay('2026-11-27', now, 'America/Phoenix') === formatDay('2026-11-27', now, 'Asia/Tokyo')
    && /27/.test(formatDay('2026-11-27', now, 'America/Phoenix')), [formatDay('2026-11-27', now, 'America/Phoenix'), formatDay('2026-11-27', now, 'Asia/Tokyo')]);
  check('format: the year shows when it is not this year in the zone', /2027/.test(formatDay('2027-01-01T12:00:00Z', now, 'UTC')) && !/2026/.test(formatDay('2026-11-26T12:00:00Z', now, 'UTC')));
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec('RESET ROLE');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    if (login) {
      // The test database's sign-up trigger makes the member for a new login.
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      const made = (await q<{ id: string }>('SELECT id FROM pm.team_members WHERE auth_user_id = $1', [login.id]))[0]?.id;
      if (made) {
        // Owner first, so the at-least-one-Owner rule always holds.
        await q("UPDATE pm.team_members SET name = $1, role = $2, timezone = 'UTC', timezone_set = false WHERE id = $3", [name, role, made]);
        return made;
      }
    }
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase().replace(/\W/g, '')}@example.com`, role]))[0].id;
    if (login) await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    return id;
  };
  const owner = await member('Morgan Hale', 'owner', LOGINS.owner);
  const guest = await member('Casey Brooks', 'guest', LOGINS.guest);
  const sam = await member('Sam Lee', 'member', LOGINS.member);
  const forge = await member('Forge', 'agent');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Website relaunch') RETURNING id"))[0].id;
  for (const m of [owner, guest, sam, forge]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [project, m]);
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Deploy redirects') RETURNING id", [project]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, guest]);
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Clients', 'clients') RETURNING id"))[0].id;
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, guest]);
  const ask = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    return (await q<{ id: string }>(`INSERT INTO pm.questions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(fields)))[0].id;
  };
  const internalApproval = await ask({
    task_id: task, project_id: project, asked_by: forge, asked_to: sam, question: 'Deploy 214 redirect rules to production?',
    kind: 'approval', action: JSON.stringify({ type: 'deploy', summary: 'Deploy 214 redirect rules' }), choices: JSON.stringify(['approve', 'reject']), allow_other: false,
  });
  const internalQuestion = await ask({ task_id: task, project_id: project, asked_by: forge, asked_to: owner, question: 'Is the green palette approved for the hero?' });
  const toGuest = await ask({ task_id: task, project_id: project, asked_by: forge, asked_to: guest, question: 'Can you send the logo files?' });
  const toGroup = await ask({ task_id: task, project_id: project, asked_by: sam, asked_to: null, asked_to_group: group, question: 'Which launch date suits you?' });
  // A guest's API key (tasks.read), for the task read and the brief.
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const guestKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
    VALUES ('Guest key', 'pk_live', $1, $2, '{tasks.read}', 'scoped')`, [createHash('sha256').update(guestKey).digest('hex'), guest]);
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    VALUES ($1, 'tasks.read', 'api', 'allow') ON CONFLICT DO NOTHING`, [guest]);
  return { q, owner, guest, sam, forge, project, task, group, internalApproval, internalQuestion, toGuest, toGroup, guestKey };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  pureChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
  });
  installSession(server.url);
  try {
    const memberRoute = await import('../src/app/api/workspace/team-members/[id]/route');
    const questionsRoute = await import('../src/app/api/workspace/questions/route');
    const notificationsRoute = await import('../src/app/api/workspace/notifications/route');
    const { upsertNotification } = await import('../src/lib/api/notifications');
    const { openQuestionForTask } = await import('../src/lib/api/questions');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const call = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      const text = await response.text();
      let json: Loose = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, body: json };
    };
    const patchMember = (id: string, body: unknown) => call(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${id}`, { id }, body);
    await db.exec('RESET ROLE');
    const row = async (id: string) => (await s.q<{ name: string; timezone: string; timezone_set: boolean }>('SELECT name, timezone, timezone_set FROM pm.team_members WHERE id = $1', [id]))[0];

    // --- 1. A name is required ------------------------------------------------------------
    signedIn = LOGINS.owner;
    const blank = await patchMember(s.owner, { name: '   ' });
    check('Settings: a blank name is refused (422) and nothing is saved', blank.status === 422 && /Enter a name/.test(blank.body?.error ?? '') && (await row(s.owner)).name === 'Morgan Hale', [blank, await row(s.owner)]);
    const empty = await patchMember(s.owner, { name: '' });
    check('Settings: an empty name is refused', empty.status === 422, empty);
    const trimmed = await patchMember(s.owner, { name: '  Morgan  Hale ' });
    check('Settings: a padded name is saved trimmed', trimmed.status === 200 && (await row(s.owner)).name === 'Morgan Hale', [trimmed.status, await row(s.owner)]);

    // --- 8. Time zones --------------------------------------------------------------------
    check('zone: every profile starts unset (the default UTC)', (await row(s.sam)).timezone === 'UTC' && (await row(s.sam)).timezone_set === false, await row(s.sam));
    signedIn = LOGINS.member;
    const badZone = await patchMember(s.sam, { timezone: 'Mars/Base' });
    check('zone: an unknown zone is refused', badZone.status === 422, badZone);
    const defaulted = await patchMember(s.sam, { timezone: 'America/Phoenix', timezone_default: true });
    check('zone: first sign-in saves the browser\'s zone to an unset profile', defaulted.status === 200 && defaulted.body?.data?.timezone === 'America/Phoenix'
      && (await row(s.sam)).timezone_set === true, [defaulted, await row(s.sam)]);
    const again = await patchMember(s.sam, { timezone: 'Asia/Tokyo', timezone_default: true });
    check('zone: a zone already set is kept when another browser signs in', again.status === 200 && (await row(s.sam)).timezone === 'America/Phoenix', [again.status, await row(s.sam)]);
    const chosenUtc = await patchMember(s.sam, { timezone: 'UTC' });
    check('zone: choosing UTC in Settings makes it the person\'s own', chosenUtc.status === 200 && (await row(s.sam)).timezone === 'UTC' && (await row(s.sam)).timezone_set === true, await row(s.sam));
    const notMine = await patchMember(s.owner, { timezone: 'UTC', timezone_default: true });
    check('zone: only you default your own zone', notMine.status === 403, notMine);
    await s.q("UPDATE pm.team_members SET timezone = 'Europe/Paris' WHERE id = $1", [s.forge]);
    check('zone: a zone set through any path (the API) counts as chosen', (await row(s.forge)).timezone_set === true);

    // --- 2. Notifications: sender and links -------------------------------------------------
    await upsertNotification(service, {
      userId: s.owner, title: 'Morgan approved the deploy: action needed', message: 'Your session expired.',
      link: 'https://evil.test/cb', entityType: 'task', entityId: s.task, category: 'task_comments', actorId: s.guest,
    });
    await upsertNotification(service, {
      userId: s.owner, title: 'Website relaunch is due tomorrow', message: '', link: '/projects/' + s.project,
      entityType: 'project', entityId: s.project, category: 'project',
    });
    await db.exec('RESET ROLE');
    const stored = await s.q<{ title: string; link: string | null }>('SELECT title, link FROM pm.team_member_notifications WHERE user_id = $1 ORDER BY created_at', [s.owner]);
    check('notify: a URL link is never stored', stored.find((n) => n.title.startsWith('Morgan approved'))?.link === null, stored);
    check('notify: an in-app path is kept', stored.find((n) => n.title.startsWith('Website'))?.link === `/projects/${s.project}`, stored);
    // A row written straight into the table (an older release) still reads with no link.
    await s.q("INSERT INTO pm.team_member_notifications (user_id, title, message, link, entity_type, entity_id, actor_id) VALUES ($1, 'Old row', '', '//evil.test', 'task', $2, $3)", [s.owner, randomUUID(), s.sam]);
    signedIn = LOGINS.owner;
    const feed = await call(notificationsRoute.GET, 'GET', '/api/workspace/notifications?view=updates');
    const items = (feed.body?.data?.items ?? []) as Loose[];
    const fromGuest = items.find((n) => n.title.startsWith('Morgan approved'));
    const system = items.find((n) => n.title.startsWith('Website'));
    const old = items.find((n) => n.title === 'Old row');
    check('feed: a notice says who sent it, a guest marked as one', feed.status === 200 && fromGuest?.actor?.name === 'Casey Brooks' && fromGuest?.actor?.role === 'guest'
      && notificationSenderLabel(notificationSender(fromGuest)) === 'From Casey Brooks (guest)', [feed.status, fromGuest]);
    check('feed: the app\'s own notice has no sender', !!system && system.actor === null && notificationSenderLabel(notificationSender(system)) === 'From the app', system);
    check('feed: an old row\'s outside link reads as no link', old?.link === null && old?.actor?.name === 'Sam Lee', old);

    // --- 3. Guests see only what is addressed to them ---------------------------------------------
    signedIn = LOGINS.guest;
    const guestList = await call(questionsRoute.GET, 'GET', '/api/workspace/questions');
    const guestIds = new Set(((guestList.body?.data ?? []) as { id: string }[]).map((q) => q.id));
    check('guest: sees the question asked of them and of their group', guestList.status === 200 && guestIds.has(s.toGuest) && guestIds.has(s.toGroup), [guestList.status, [...guestIds]]);
    check('guest: never sees the team\'s internal approval or question on their own task', !guestIds.has(s.internalApproval) && !guestIds.has(s.internalQuestion), [...guestIds]);
    signedIn = LOGINS.member;
    const memberList = await call(questionsRoute.GET, 'GET', '/api/workspace/questions');
    const memberIds = new Set(((memberList.body?.data ?? []) as { id: string }[]).map((q) => q.id));
    check('member: still sees the team\'s questions on tasks they can open', memberIds.has(s.internalApproval) && memberIds.has(s.internalQuestion) && memberIds.has(s.toGuest), [...memberIds]);
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, path: string, id: string) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, { headers: { 'x-api-key': s.guestKey } }), { params: Promise.resolve({ id }) } as never);
      return { status: response.status, body: await response.json() as Loose };
    };
    const taskRead = await v1((await import('../src/app/api/v1/tasks/[id]/route')).GET, `/api/v1/tasks/${s.task}`, s.task);
    check('API task read: the open question for a guest is one addressed to them', taskRead.status === 200 && taskRead.body?.data?.open_question?.id === s.toGuest,
      [taskRead.status, taskRead.body?.data?.open_question ?? taskRead.body?.error]);
    const brief = await v1((await import('../src/app/api/v1/tasks/[id]/brief/route')).GET, `/api/v1/tasks/${s.task}/brief`, s.task);
    check('API task brief: a guest never gets the team open question', brief.status === 200 && brief.body?.data?.open_question?.id === s.toGuest,
      [brief.status, brief.body?.data?.open_question ?? brief.body?.error]);
    const guestOpen = await openQuestionForTask(service, s.task, { memberId: s.guest });
    const teamOpen = await openQuestionForTask(service, s.task);
    check('task read: a guest\'s open question is one addressed to them', guestOpen?.id === s.toGuest && teamOpen?.id === s.internalApproval, [guestOpen?.id, teamOpen?.id]);

    await actAs(db, LOGINS.guest.id);
    const rlsGuest = (await db.query<{ id: string }>('SELECT id FROM pm.questions')).rows.map((r) => r.id);
    const guestTask = (await db.query<{ id: string }>('SELECT id FROM pm.tasks WHERE id = $1', [s.task])).rows.length;
    await actAs(db, LOGINS.member.id);
    const rlsMember = (await db.query<{ id: string }>('SELECT id FROM pm.questions')).rows.map((r) => r.id);
    await actAs(db, null);
    await db.exec('RESET ROLE');
    check('row security: the guest can open the task', guestTask === 1, guestTask);
    check('row security: a guest reads only the questions addressed to them', rlsGuest.length === 2 && rlsGuest.includes(s.toGuest) && rlsGuest.includes(s.toGroup), rlsGuest);
    check('row security: a member reads every question on the task', [s.internalApproval, s.internalQuestion, s.toGuest, s.toGroup].every((id) => rlsMember.includes(id)), rlsMember);
  } finally {
    await server.close();
    await db.close();
  }

  // --- The migration, twice, on the schema before it ------------------------------------------
  // The schema before it: today's schema.sql without this migration's section (git history cannot give it
  // once other branches' sections are merged in before this one).
  const schemaNow = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
  const sectionAt = schemaNow.lastIndexOf('\n-- ====', schemaNow.indexOf(`(${MIGRATION})`));
  const before = await createFullSchemaDatabase({ schemaSql: schemaNow.slice(0, sectionAt) });
  await before.exec('RESET ROLE');
  await before.query("INSERT INTO pm.team_members (name, email, role, timezone) VALUES ('Old UTC', 'old-utc@example.com', 'member', 'UTC'), ('Old Phoenix', 'old-phx@example.com', 'member', 'America/Phoenix')");
  await applyMigrationsFrom(before, MIGRATION);
  const upgraded = (await before.query<{ name: string; timezone_set: boolean }>("SELECT name, timezone_set FROM pm.team_members WHERE name LIKE 'Old %' ORDER BY name")).rows;
  check('upgrade: a stored zone other than UTC counts as chosen, the default UTC as unset', upgraded.length === 2
    && upgraded.find((r) => r.name === 'Old Phoenix')?.timezone_set === true && upgraded.find((r) => r.name === 'Old UTC')?.timezone_set === false, upgraded);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(before));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await before.close();
  await fresh.close();

  if (failures.length) {
    console.error(`ui fixes: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`ui fixes: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
