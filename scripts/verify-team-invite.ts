/**
 * Team invitations (lib/team/invite.ts) on the full schema in PGlite, with
 * the real supabase-js client behind fake-postgrest and a small stand-in for
 * Supabase Auth's admin API (create, read, update and list users).
 *
 * Covers: an invite without a password creates the account with no password,
 * stores only the hash of a 7-day token and returns the link; email goes out
 * only with an SMTP account (and never to an agent), and a failed send still
 * returns the link; only an Owner invites an Owner or Admin; a taken email is
 * refused; the older password path still works; the pending list and Resend
 * invite follow the same role rules; a resend replaces the old link; a link
 * sets the password once, and an expired, used, unknown or malformed link,
 * or one for someone who has signed in, is refused the same way; reading a
 * link spends nothing; a password Supabase refuses leaves the link usable.
 * Since 2.0 there is no sign-up trigger: the server adds members
 * (pm.add_team_member). An email that already has a login (another app's
 * user) joins on that login with login_owned false, gets a sign-in email and
 * no set-password link, and reissueInvite, redeemInvite and the
 * update-email route all refuse to touch that login.
 *
 *   npm run -s test:team-invite
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PGlite } from '@electric-sql/pglite';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 800)}`);
}

const APP_URL = 'https://pm.example.com';

/** What the fake Auth server knows beyond auth.users: passwords sent and sign-ins. */
interface AuthUser { id: string; email: string; password?: string; last_sign_in_at: string | null; meta: Record<string, unknown> }

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? JSON.parse(text) : {}));
    request.on('error', reject);
  });
}

function authStandIn(db: PGlite, users: Map<string, AuthUser>) {
  const json = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
    return true;
  };
  const shape = (user: AuthUser) => ({
    id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
    user_metadata: user.meta, app_metadata: {}, last_sign_in_at: user.last_sign_in_at, created_at: '2026-11-21T00:00:00Z',
  });
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    // The signed-in user behind a session token (the update-email route's session).
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
      const sub = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString() || '{}').sub;
      const user = users.get(sub);
      return user ? json(response, 200, shape(user)) : json(response, 401, { code: 'bad_jwt', message: 'invalid JWT' });
    }
    if (!url.pathname.startsWith('/auth/v1/admin/')) return false;
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const body = await readBody(request);
      const email = String(body.email).toLowerCase();
      if ([...users.values()].some((user) => user.email === email)) {
        return json(response, 422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
      }
      const user: AuthUser = {
        id: randomUUID(), email, last_sign_in_at: null,
        password: typeof body.password === 'string' ? body.password : undefined,
        meta: (body.user_metadata as Record<string, unknown>) ?? {},
      };
      users.set(user.id, user);
      await db.exec('RESET ROLE');
      // Only the login: since 2.0 the server adds the member (pm.add_team_member).
      // email_confirm: true (what the app sends) confirms it, as on Supabase.
      await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES ($1, $2, $3::jsonb, CASE WHEN $4 THEN now() END)', [user.id, email, JSON.stringify(user.meta), body.email_confirm === true]);
      return json(response, 200, shape(user));
    }
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'GET') {
      return json(response, 200, { users: [...users.values()].map(shape), aud: 'authenticated' });
    }
    const one = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one && request.method === 'GET') {
      const user = users.get(one[1]);
      return user ? json(response, 200, shape(user)) : json(response, 404, { code: 'user_not_found', message: 'User not found' });
    }
    if (one && request.method === 'PUT') {
      const user = users.get(one[1]);
      if (!user) return json(response, 404, { code: 'user_not_found', message: 'User not found' });
      const body = await readBody(request);
      if (body.password === 'weakweak') return json(response, 422, { code: 'weak_password', message: 'Password is known to be weak' });
      if (typeof body.password === 'string') user.password = body.password;
      if (typeof body.email === 'string') user.email = body.email;
      return json(response, 200, shape(user));
    }
    return json(response, 404, { message: `No fake for ${request.method} ${url.pathname}` });
  };
}

/**
 * Session routes read the signed-in user from cookies (next/headers): this
 * hands them a session cookie for `authUserId`, as @supabase/ssr stores it.
 * Its token is checked against the fake Auth server's /auth/v1/user.
 */
function signInAs(supabaseUrl: string, authUserId: string, email: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: authUserId, email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
  const session = {
    access_token: accessToken, refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: { id: authUserId, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-21T00:00:00Z' },
  };
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const store = {
    getAll: () => [{ name, value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }],
    get: (key: string) => store.getAll().find((cookie) => cookie.name === key),
    set: () => undefined,
  };
  const nextHeaders = createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> };
  nextHeaders.cookies = async () => store;
}

async function main() {
  const db = await createFullSchemaDatabase();
  // A 2.0 install: no trigger on auth.users, the server adds every member.
  await db.exec('DROP TRIGGER on_auth_user_created ON auth.users');
  const users = new Map<string, AuthUser>();
  const server = await startFakePostgrest(db, { handle: authStandIn(db, users) });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  const q = async <T,>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  try {
    const { inviteMember, reissueInvite, listPendingInvites, inviteSchema, redeemInvite, peekInvite, hashInviteToken, canInviteRole, canChangeSignInEmail, NOT_OUR_LOGIN, UNCONFIRMED_LOGIN } = await import('../src/lib/team/invite');
    // Changing someone else's sign-in email (update-email route) is Owner only.
    check('email: only the person or an Owner changes a sign-in email', canChangeSignInEmail('member', true) && canChangeSignInEmail('owner', false) && !canChangeSignInEmail('admin', false));
    check('rule: an Admin cannot manage the sign-in of an agent or Admin', !canInviteRole('admin', 'agent') && !canInviteRole('admin', 'admin'));
    check('rule: an Admin manages the sign-in of a Member or Guest', canInviteRole('admin', 'member') && canInviteRole('admin', 'guest'));
    check('rule: an Owner manages the sign-in of anyone', ['owner', 'admin', 'agent', 'member'].every((role) => canInviteRole('owner', role)));
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    // ---- Seed an Owner (signed in) and an Admin, through the same fake Auth ----
    const seedPerson = async (email: string, role: string, signedIn: boolean) => {
      const id = randomUUID();
      users.set(id, { id, email, last_sign_in_at: signedIn ? '2026-11-20T10:00:00Z' : null, meta: {} });
      await q('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
      const row = (await q<{ id: string }>('SELECT (pm.add_team_member($1, $2, $3, $4)).id', [id, email, email.split('@')[0], role]))[0];
      await q(`UPDATE pm.team_members SET status = 'active' WHERE id = $1`, [row.id]);
      return row.id;
    };
    const ownerId = await seedPerson('owner@example.com', 'owner', true);
    const adminId = await seedPerson('admin@example.com', 'admin', true);
    const owner = (await resolveMemberAccess(service, ownerId))!;
    const admin = (await resolveMemberAccess(service, adminId))!;

    const sent: Array<{ to: string; subject: string; html: string }> = [];
    let mailFails = false;
    const mailer = async (message: { to: string; subject: string; html: string }) => {
      sent.push(message);
      return mailFails ? { success: false, error: 'SMTP said no' } : { success: true };
    };
    const base = { service, appUrl: APP_URL, inviterName: 'Olive Owner', mailer };
    const authUserFor = (email: string) => [...users.values()].find((user) => user.email === email);
    const attempt = async <T,>(work: () => Promise<T>) => {
      try {
        return { value: await work(), error: null };
      } catch (error) {
        return { value: null, error: error as { status: number; message: string } };
      }
    };

    // ---- The body: password optional ------------------------------------------
    check('schema: an invite without a password is valid', inviteSchema.safeParse({ name: 'Ann', email: 'ANN@Example.com ', role: 'member' }).success);
    check('schema: email is trimmed and lowercased', inviteSchema.parse({ name: 'Ann', email: ' ANN@Example.com', role: 'member' }).email === 'ann@example.com');
    check('schema: a short password is still refused', !inviteSchema.safeParse({ name: 'Ann', email: 'ann@example.com', role: 'member', password: '123' }).success);

    // ---- Invite without a password, email not set up ----------------------------
    const first = await inviteMember({ ...base, access: owner, input: { name: 'Maya Member', email: 'maya@example.com', role: 'member' } });
    const maya = authUserFor('maya@example.com');
    check('invite: the account exists', !!maya);
    check('invite: no password was set on the account', !!maya && maya.password === undefined, maya);
    check('invite: the member row has the name and role', first.member.name === 'Maya Member' && first.member.role === 'member', first.member);
    const link = first.invite?.link ?? '';
    const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';
    const token = tokenOf(link);
    check('invite: a link comes back', link.startsWith(`${APP_URL}/welcome/set-password?token=`), first.invite);
    check('invite: the token is 32 random bytes', /^[A-Za-z0-9_-]{43}$/.test(token), token);
    const stored = await q<{ token_hash: string; member_id: string; created_by: string; expires_at: string; created_at: string; used_at: string | null }>(
      'SELECT token_hash, member_id, created_by, expires_at, created_at, used_at FROM pm.team_invites WHERE member_id = $1', [first.member.id]);
    check('token: one invite row for that person, from the inviter', stored.length === 1 && stored[0].created_by === ownerId, stored);
    check('token: stored as its sha256, never as itself', stored[0]?.token_hash === createHash('sha256').update(token).digest('hex')
      && stored[0]?.token_hash === hashInviteToken(token) && !JSON.stringify(stored).includes(token), stored);
    const lifetime = stored[0] ? new Date(stored[0].expires_at).getTime() - new Date(stored[0].created_at).getTime() : 0;
    check('token: lasts 7 days', Math.abs(lifetime - 7 * 24 * 3600 * 1000) < 5000, lifetime);
    check('invite: no SMTP account, so no email and it says why', first.invite?.emailed === false && first.invite?.emailStatus === 'not_configured', first.invite);
    check('invite: the mailer was not called', sent.length === 0, sent);

    // ---- Role rules ---------------------------------------------------------------
    const before = users.size;
    const adminMakesAdmin = await attempt(() => inviteMember({ ...base, access: admin, input: { name: 'Ada', email: 'ada@example.com', role: 'admin' } }));
    check('roles: an Admin cannot invite an Admin', adminMakesAdmin.error?.status === 403, adminMakesAdmin.error?.message);
    const adminMakesOwner = await attempt(() => inviteMember({ ...base, access: admin, input: { name: 'Oz', email: 'oz@example.com', role: 'owner' } }));
    check('roles: an Admin cannot invite an Owner', adminMakesOwner.error?.status === 403);
    check('roles: a refused invite creates no account', users.size === before, users.size);
    const adminMakesMember = await attempt(() => inviteMember({ ...base, access: admin, input: { name: 'Gus Guest', email: 'gus@example.com', role: 'guest' } }));
    check('roles: an Admin can invite a Guest', adminMakesMember.value?.member.role === 'guest', adminMakesMember.error?.message);
    const ownerMakesAdmin = await attempt(() => inviteMember({ ...base, access: owner, input: { name: 'Al Admin', email: 'al@example.com', role: 'admin' } }));
    check('roles: an Owner can invite an Admin', ownerMakesAdmin.value?.member.role === 'admin', ownerMakesAdmin.error?.message);

    const usersBeforeDuplicate = users.size;
    const duplicate = await attempt(() => inviteMember({ ...base, access: owner, input: { name: 'Maya again', email: 'maya@example.com', role: 'member' } }));
    check('invite: an email already on the team is refused with 409', duplicate.error?.status === 409 && /already on the team/.test(duplicate.error.message), duplicate.error?.message);
    check('invite: and adds no login and no second row', users.size === usersBeforeDuplicate
      && (await q('SELECT 1 FROM pm.team_members WHERE email = $1', ['maya@example.com'])).length === 1);

    // ---- The older password path ----------------------------------------------------
    const legacy = await inviteMember({ ...base, access: owner, input: { name: 'Pat', email: 'pat@example.com', role: 'member', password: 'secret-123' } });
    check('password path: the account gets that password', authUserFor('pat@example.com')?.password === 'secret-123');
    check('password path: no invite link', legacy.invite === null);

    // ---- With an SMTP account: the invite is emailed ---------------------------------
    await q(`INSERT INTO pm.smtp_accounts (label, host, username, encrypted_password, from_name, from_email, is_default)
      VALUES ('Main', 'smtp.example.com', 'user', 'x', 'Team', 'team@example.com', true)`);
    const emailed = await inviteMember({ ...base, access: owner, input: { name: 'Eve Email', email: 'eve@example.com', role: 'member' } });
    check('email: it went out', emailed.invite?.emailed === true && emailed.invite.emailStatus === 'sent', emailed.invite);
    check('email: to the person, with their link', sent.length === 1 && sent[0].to === 'eve@example.com' && sent[0].html.includes(emailed.invite!.link.replace(/&/g, '&amp;')), sent.map((m) => m.to));
    check('email: the link still comes back to the inviter', !!emailed.invite?.link);

    mailFails = true;
    const failedSend = await inviteMember({ ...base, access: owner, input: { name: 'Fay Fail', email: 'fay@example.com', role: 'member' } });
    check('email: a failed send says so and keeps the link', failedSend.invite?.emailStatus === 'failed' && failedSend.invite.emailed === false && !!failedSend.invite.link && failedSend.invite.emailError === 'SMTP said no', failedSend.invite);
    mailFails = false;

    const sentBefore = sent.length;
    const agent = await inviteMember({ ...base, access: owner, input: { name: 'Bot', email: 'bot@example.com', role: 'agent' } });
    check('email: an agent gets a link and no email', agent.invite?.emailStatus === 'skipped' && sent.length === sentBefore, agent.invite);

    // ---- An email that already has a login (another app's user, shared project) -----
    // An unconfirmed login under that email may be someone else's sign-up: never linked.
    const malloryId = randomUUID();
    users.set(malloryId, { id: malloryId, email: 'boss@example.com', password: 'mallory-pass', last_sign_in_at: null, meta: {} });
    await q('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [malloryId, 'boss@example.com']);
    const unconfirmed = await attempt(() => inviteMember({ ...base, access: owner, input: { name: 'Boss', email: 'boss@example.com', role: 'admin' } }));
    check('existing login: an unconfirmed one is refused (409) with what to do', unconfirmed.error?.status === 409 && unconfirmed.error.message === UNCONFIRMED_LOGIN, unconfirmed.error);
    check('existing login: and no member is made on it', (await q('SELECT 1 FROM pm.team_members WHERE auth_user_id = $1', [malloryId])).length === 0);

    const lenaId = randomUUID();
    users.set(lenaId, { id: lenaId, email: 'lena@example.com', password: 'other-app-pass', last_sign_in_at: '2026-11-01T08:00:00Z', meta: {} });
    await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [lenaId, 'lena@example.com']);
    const usersBeforeLena = users.size;
    const sentBeforeLena = sent.length;
    const lena = await inviteMember({ ...base, access: owner, input: { name: 'Lena Login', email: 'lena@example.com', role: 'member' } });
    const lenaRow = (await q<{ id: string; auth_user_id: string; role: string; login_owned: boolean }>(
      'SELECT id, auth_user_id, role, login_owned FROM pm.team_members WHERE email = $1', ['lena@example.com']));
    check('existing login: added to the team on that login, with the role given', lenaRow.length === 1 && lenaRow[0].auth_user_id === lenaId && lenaRow[0].role === 'member', lenaRow);
    check('existing login: marked as a login PM did not make (login_owned false)', lenaRow[0]?.login_owned === false && lena.member.login_owned === false, lenaRow);
    check('existing login: no new login and its password untouched', users.size === usersBeforeLena && authUserFor('lena@example.com')?.password === 'other-app-pass');
    const lenaInvites = await q('SELECT 1 FROM pm.team_invites WHERE member_id = $1', [lena.member.id]);
    check('existing login: no set-password link is made', lenaInvites.length === 0 && !lena.invite?.link.includes('set-password') && lena.invite?.link === `${APP_URL}/login`, { invites: lenaInvites, invite: lena.invite });
    const lenaMail = sent.slice(sentBeforeLena);
    check('existing login: the email says to sign in with the existing account', lenaMail.length === 1 && lenaMail[0].to === 'lena@example.com'
      && /already use/.test(lenaMail[0].html) && !lenaMail[0].html.includes('set-password'), lenaMail.map((m) => m.subject));
    const lenaAgain = await attempt(() => inviteMember({ ...base, access: owner, input: { name: 'Lena Again', email: 'lena@example.com', role: 'member' } }));
    check('existing login: inviting it again is a 409', lenaAgain.error?.status === 409, lenaAgain.error?.message);
    const olafId = randomUUID();
    users.set(olafId, { id: olafId, email: 'olaf@example.com', password: 'olaf-own', last_sign_in_at: null, meta: {} });
    await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [olafId, 'olaf@example.com']);
    const typedOver = await attempt(() => inviteMember({ ...base, access: owner, input: { name: 'Olaf', email: 'olaf@example.com', role: 'member', password: 'typed-for-olaf' } }));
    check('existing login: a password typed for it is refused (409), the login keeps its own', typedOver.error?.status === 409 && authUserFor('olaf@example.com')?.password === 'olaf-own', typedOver.error?.message);

    // PM never sends links for, or changes, a login it did not make.
    const reissueLena = await attempt(() => reissueInvite({ ...base, access: owner, memberId: lena.member.id, send: true }));
    check('existing login: reissueInvite refuses it (409)', reissueLena.error?.status === 409 && reissueLena.error.message === NOT_OUR_LOGIN, reissueLena.error);
    check('existing login: and makes no link', (await q('SELECT 1 FROM pm.team_invites WHERE member_id = $1', [lena.member.id])).length === 0);
    // A link that somehow exists for such a member (one never signed in, so it gets past the expiry rules).
    authUserFor('lena@example.com')!.last_sign_in_at = null;
    const lenaToken = randomBytes(32).toString('base64url');
    await q(`INSERT INTO pm.team_invites (member_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
      [lena.member.id, hashInviteToken(lenaToken), ownerId]);
    const redeemLena = await attempt(() => redeemInvite(service, { token: lenaToken, password: 'taken-over' }));
    check('existing login: redeemInvite refuses it (409) and sets no password', redeemLena.error?.status === 409 && redeemLena.error.message === NOT_OUR_LOGIN
      && authUserFor('lena@example.com')?.password === 'other-app-pass', redeemLena.error);
    const lenaLink = await q<{ used_at: string | null }>('SELECT used_at FROM pm.team_invites WHERE member_id = $1', [lena.member.id]);
    check('existing login: the link is not spent', lenaLink.length === 1 && lenaLink[0].used_at === null, lenaLink);

    // The update-email route, as the signed-in Owner.
    const ownerAuth = (await q<{ auth_user_id: string }>('SELECT auth_user_id FROM pm.team_members WHERE id = $1', [ownerId]))[0].auth_user_id;
    signInAs(server.url, ownerAuth, 'owner@example.com');
    const { POST: updateEmail } = await import('../src/app/api/team-members/update-email/route');
    const { NextRequest } = await import('next/server');
    const changeEmail = (memberId: string, email: string) => updateEmail(new NextRequest('http://localhost/api/team-members/update-email', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team_member_id: memberId, new_email: email }),
    }));
    const lenaEmail = await changeEmail(lena.member.id, 'lena.new@example.com');
    const lenaEmailBody = await lenaEmail.json() as { error?: string };
    check('existing login: the update-email route refuses it (409)', lenaEmail.status === 409 && lenaEmailBody.error === NOT_OUR_LOGIN, { status: lenaEmail.status, body: lenaEmailBody });
    check('existing login: and its sign-in email stays', authUserFor('lena@example.com')?.id === lenaId
      && (await q<{ email: string }>('SELECT email FROM pm.team_members WHERE id = $1', [lena.member.id]))[0]?.email === 'lena@example.com');
    // The same route still changes a login PM made (the session works).
    const patEmail = await changeEmail(legacy.member.id, 'pat.new@example.com');
    check('update-email: still changes a login PM made', patEmail.status === 200 && !!authUserFor('pat.new@example.com'), patEmail.status);

    // ---- Who has not signed in yet ---------------------------------------------------
    const pending = new Set(await listPendingInvites(service));
    check('pending: an invited person is listed', pending.has(first.member.id));
    check('pending: someone who signed in is not', !pending.has(ownerId) && !pending.has(adminId));
    check('pending: an agent is not', !pending.has(agent.member.id));

    // ---- Resend invite and Copy invite link -------------------------------------------
    const alId = ownerMakesAdmin.value!.member.id;
    const adminResendsAdmin = await attempt(() => reissueInvite({ ...base, access: admin, memberId: alId, send: true }));
    check('reissue: an Admin cannot re-invite an Admin', adminResendsAdmin.error?.status === 403);
    const adminResendsAgent = await attempt(() => reissueInvite({ ...base, access: admin, memberId: agent.member.id, send: false }));
    check('reissue: an Admin cannot make a sign-in link for an agent', adminResendsAgent.error?.status === 403, adminResendsAgent.error?.message);
    const adminMakesAgent = await attempt(() => inviteMember({ ...base, access: admin, input: { name: 'Bot Two', email: 'bot2@example.com', role: 'agent' } }));
    check('roles: an Admin cannot invite an agent', adminMakesAgent.error?.status === 403, adminMakesAgent.error?.message);
    const signedIn = await attempt(() => reissueInvite({ ...base, access: owner, memberId: adminId, send: true }));
    check('reissue: someone who has signed in is refused', signedIn.error?.status === 409, signedIn.error?.message);
    const copyBefore = sent.length;
    const copy = await reissueInvite({ ...base, access: owner, memberId: first.member.id, send: false });
    check('reissue: Copy invite link makes a new link and sends nothing', tokenOf(copy.link).length === 43 && copy.link !== link && sent.length === copyBefore, copy);
    const rows = await q<{ token_hash: string }>('SELECT token_hash FROM pm.team_invites WHERE member_id = $1', [first.member.id]);
    check('resend: the old link is replaced, one invite left', rows.length === 1 && rows[0].token_hash === hashInviteToken(tokenOf(copy.link)), rows);
    const oldLink = await attempt(() => redeemInvite(service, { token, password: 'a-good-password' }));
    check('resend: the old link no longer works', oldLink.error?.status === 410, oldLink.error);
    const resend = await reissueInvite({ ...base, access: admin, memberId: first.member.id, send: true });
    check('reissue: Resend invite emails a fresh link', resend.emailStatus === 'sent' && sent.at(-1)?.to === 'maya@example.com', resend);
    // ---- Using a link --------------------------------------------------------------------
    const rita = await inviteMember({ ...base, access: owner, input: { name: 'Rita Redeem', email: 'rita@example.com', role: 'member' } });
    const ritaToken = tokenOf(rita.invite!.link);
    const peek = await attempt(() => peekInvite(service, ritaToken));
    check('peek: says who the link is for', peek.value?.name === 'Rita Redeem', peek.error ?? peek.value);
    const afterPeek = await q<{ used_at: string | null }>('SELECT used_at FROM pm.team_invites WHERE member_id = $1', [rita.member.id]);
    check('peek: reading a link spends nothing', afterPeek.length === 1 && afterPeek[0].used_at === null, afterPeek);

    const unknown = await attempt(() => redeemInvite(service, { token: randomBytes(32).toString('base64url'), password: 'a-good-password' }));
    check('redeem: an unknown token is refused as expired', unknown.error?.status === 410 && unknown.error.message === 'This link has expired', unknown.error);
    const malformed = await attempt(() => redeemInvite(service, { token: "x' OR 1=1 --", password: 'a-good-password' }));
    check('redeem: a malformed token is refused the same way', malformed.error?.status === 410, malformed.error);

    const weak = await attempt(() => redeemInvite(service, { token: ritaToken, password: 'weakweak' }));
    check('redeem: a password Supabase refuses says why', weak.error?.status === 422 && /weak/.test(weak.error.message), weak.error);
    const ritaAfterWeak = await q<{ used_at: string | null }>('SELECT used_at FROM pm.team_invites WHERE member_id = $1', [rita.member.id]);
    check('redeem: and leaves the link usable', ritaAfterWeak[0]?.used_at === null, ritaAfterWeak);

    const redeemedTry = await attempt(() => redeemInvite(service, { token: ritaToken, password: 'rita-chose-this' }));
    check('redeem: returns the email to sign in with', redeemedTry.value?.email === 'rita@example.com', redeemedTry.error ?? redeemedTry.value);
    check('redeem: the password is set', authUserFor('rita@example.com')?.password === 'rita-chose-this');
    const ritaUsed = await q<{ used_at: string | null }>('SELECT used_at FROM pm.team_invites WHERE member_id = $1', [rita.member.id]);
    check('redeem: the invite is marked used', !!ritaUsed[0]?.used_at, ritaUsed);
    const again = await attempt(() => redeemInvite(service, { token: ritaToken, password: 'someone-else' }));
    check('redeem: a used link is refused', again.error?.status === 410, again.error);
    check('redeem: and the password stays as chosen', authUserFor('rita@example.com')?.password === 'rita-chose-this');
    const peekUsed = await attempt(() => peekInvite(service, ritaToken));
    check('peek: a used link reads as expired', peekUsed.error?.status === 410);

    const ted = await inviteMember({ ...base, access: owner, input: { name: 'Ted Late', email: 'ted@example.com', role: 'member' } });
    await q(`UPDATE pm.team_invites SET expires_at = now() - interval '1 minute' WHERE member_id = $1`, [ted.member.id]);
    const expired = await attempt(() => redeemInvite(service, { token: tokenOf(ted.invite!.link), password: 'a-good-password' }));
    check('redeem: an expired link is refused', expired.error?.status === 410 && authUserFor('ted@example.com')?.password === undefined, expired.error);
    const later = await attempt(() => redeemInvite(service, { token: tokenOf(ted.invite!.link), password: 'next-week-pass', now: new Date(Date.now() - 60 * 60 * 1000) }));
    check('redeem: a link inside its 7 days still works', later.value?.email === 'ted@example.com', later.error);

    // Two submits at once (a double click, two tabs): exactly one sets the password.
    const dee = await inviteMember({ ...base, access: owner, input: { name: 'Dee Double', email: 'dee@example.com', role: 'member' } });
    const deeToken = tokenOf(dee.invite!.link);
    const both = await Promise.all(['first-password', 'second-password'].map((password) => attempt(() => redeemInvite(service, { token: deeToken, password }))));
    const winners = both.filter((result) => result.value);
    check('redeem: two submits at once, only one wins', winners.length === 1 && both.some((result) => result.error?.status === 410), both.map((r) => r.error?.status ?? 'ok'));

    const sam = await inviteMember({ ...base, access: owner, input: { name: 'Sam Signed', email: 'sam@example.com', role: 'member' } });
    authUserFor('sam@example.com')!.last_sign_in_at = '2026-11-21T09:00:00Z';
    const signedInRedeem = await attempt(() => redeemInvite(service, { token: tokenOf(sam.invite!.link), password: 'a-good-password' }));
    check('redeem: someone who has signed in is refused', signedInRedeem.error?.status === 410 && authUserFor('sam@example.com')?.password === undefined, signedInRedeem.error);

    const sue = await inviteMember({ ...base, access: owner, input: { name: 'Sue Suspended', email: 'sue@example.com', role: 'member' } });
    await q(`UPDATE pm.team_members SET status = 'suspended' WHERE id = $1`, [sue.member.id]);
    const suspendedRedeem = await attempt(() => redeemInvite(service, { token: tokenOf(sue.invite!.link), password: 'a-good-password' }));
    check('redeem: a suspended person is refused', suspendedRedeem.error?.status === 410, suspendedRedeem.error);

    await q(`UPDATE pm.team_members SET status = 'suspended' WHERE id = $1`, [first.member.id]);
    const suspended = await attempt(() => reissueInvite({ ...base, access: owner, memberId: first.member.id, send: false }));
    check('reissue: a suspended person is refused', suspended.error?.status === 422);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`team invite: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`team invite: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
