/**
 * Sign in with Google (20261125000400_google_sign_in.sql) on the full schema
 * in PGlite, with the real supabase-js client behind fake-postgrest and a
 * small stand-in for Supabase Auth (admin users with their identities, the
 * session user, a password change, the public auth settings).
 *
 * Covers:
 * - the setting: email and password by default, only known values stored,
 *   the sign-in page never left with no way in, Google only refused until
 *   the Owner has Google linked;
 * - the roster gate: a Google login with no member row (or a suspended one)
 *   is refused, a member gets in;
 * - an invite accepted with Google only when the Google email is the invited
 *   email and the login is the invited one, used once;
 * - a member's own sign-in: unlinking the last way in is refused; a login
 *   another app made keeps its email and password (the password route
 *   refuses it) but may link Google;
 * - the first-owner Google claim needs the setup code where the project has
 *   other logins, checked again after Google, and keeps Google on;
 * - the Google photo fills an empty avatar only, never one the member set,
 *   and a member made through Google starts with it.
 *
 *   npm run -s test:google-sign-in
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 800)}`);
}

const APP_URL = 'https://pm.example.com';
const SETUP_CODE = 'a-long-random-setup-code';
const PHOTO = 'https://lh3.googleusercontent.com/a/photo-1';

interface Identity { provider: string; identity_id: string; id: string; user_id: string; identity_data: Record<string, unknown> }
interface AuthUser {
  id: string; email: string; created_at: string; last_sign_in_at: string | null;
  meta: Record<string, unknown>; identities: Identity[]; password?: string;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? JSON.parse(text) : {}));
    request.on('error', reject);
  });
}

const googleIdentity = (userId: string, email: string): Identity => ({
  provider: 'google', identity_id: randomUUID(), id: `g-${userId}`, user_id: userId, identity_data: { email, email_verified: true },
});

interface AuthCalls {
  passwordChanges: string[];
  /** Local sign-outs (the callback refusing a login). */
  signOuts: number;
  /** Who the next PKCE code exchange signs in, as Google would. */
  exchangeAs: AuthUser | null;
  /** Whether Google is on in the project's auth settings. */
  googleOn: boolean;
  /** Password reset emails Supabase was asked to send, with where their link returns. */
  recoveries: { email: string; redirectTo: string | null }[];
}

function authStandIn(db: PGlite, users: Map<string, AuthUser>, calls: AuthCalls) {
  const json = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
    return true;
  };
  const shape = (user: AuthUser) => ({
    id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
    user_metadata: user.meta, app_metadata: {}, last_sign_in_at: user.last_sign_in_at, created_at: user.created_at, identities: user.identities,
  });
  const sessionUser = (request: IncomingMessage) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    const sub = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString() || '{}').sub;
    return users.get(sub);
  };
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/settings') return json(response, 200, { external: { email: true, google: calls.googleOn }, disable_signup: false });
    if (url.pathname === '/auth/v1/recover' && request.method === 'POST') {
      const body = await readBody(request);
      calls.recoveries.push({ email: String(body.email), redirectTo: url.searchParams.get('redirect_to') });
      return json(response, 200, {});
    }
    // The callback's PKCE exchange: the code is good, the session is the Google login set up for it.
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      const body = await readBody(request);
      const user = calls.exchangeAs;
      if (!user || body.auth_code !== 'google-code' || !body.code_verifier) return json(response, 400, { code: 'bad_code', message: 'invalid code' });
      return json(response, 200, { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: shape(user) });
    }
    if (url.pathname === '/auth/v1/logout') {
      calls.signOuts++;
      response.writeHead(204);
      response.end();
      return true;
    }
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      const user = sessionUser(request);
      return user ? json(response, 200, shape(user)) : json(response, 401, { code: 'bad_jwt', message: 'invalid JWT' });
    }
    if (url.pathname === '/auth/v1/user' && request.method === 'PUT') {
      const user = sessionUser(request);
      if (!user) return json(response, 401, { code: 'bad_jwt', message: 'invalid JWT' });
      const body = await readBody(request);
      if (typeof body.password === 'string') {
        user.password = body.password;
        calls.passwordChanges.push(user.id);
        await db.exec('RESET ROLE');
        await db.query("UPDATE auth.users SET encrypted_password = 'hashed' WHERE id = $1", [user.id]);
      }
      return json(response, 200, shape(user));
    }
    if (!url.pathname.startsWith('/auth/v1/admin/')) return false;
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const body = await readBody(request);
      const email = String(body.email).toLowerCase();
      if ([...users.values()].some((user) => user.email === email)) {
        return json(response, 422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
      }
      const user: AuthUser = { id: randomUUID(), email, created_at: new Date().toISOString(), last_sign_in_at: null, meta: (body.user_metadata as Record<string, unknown>) ?? {}, identities: [] };
      users.set(user.id, user);
      await db.exec('RESET ROLE');
      await db.query("INSERT INTO auth.users (id, email, email_confirmed_at, encrypted_password) VALUES ($1, $2, now(), '')", [user.id, email]);
      return json(response, 200, shape(user));
    }
    const one = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one && request.method === 'GET') {
      const user = users.get(one[1]);
      return user ? json(response, 200, shape(user)) : json(response, 404, { code: 'user_not_found', message: 'User not found' });
    }
    return json(response, 404, { message: `No fake for ${request.method} ${url.pathname}` });
  };
}

/** Hands session routes a session cookie for this login (as @supabase/ssr stores it), checked against the fake /auth/v1/user. */
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
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  const users = new Map<string, AuthUser>();
  const calls: AuthCalls = { passwordChanges: [], signOuts: 0, exchangeAs: null, googleOn: true, recoveries: [] };
  const server = await startFakePostgrest(db, { handle: authStandIn(db, users, calls) });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  const q = async <T,>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  const attempt = async <T,>(work: () => Promise<T>) => {
    try {
      return { value: await work(), error: null as null | (Error & { status?: number; statusCode?: number; field?: string; code?: string }) };
    } catch (error) {
      return { value: null, error: error as Error & { status?: number; statusCode?: number; field?: string; code?: string } };
    }
  };
  /** A login in auth.users and the fake Auth server; Google-linked when `google` is set. */
  const addLogin = async (email: string, opts: { password?: boolean; google?: boolean; meta?: Record<string, unknown>; createdAt?: string } = {}) => {
    const id = randomUUID();
    const user: AuthUser = {
      id, email, created_at: opts.createdAt ?? new Date().toISOString(), last_sign_in_at: null, meta: opts.meta ?? {},
      identities: opts.google ? [googleIdentity(id, email)] : [],
    };
    users.set(id, user);
    await q('INSERT INTO auth.users (id, email, email_confirmed_at, encrypted_password, created_at, last_sign_in_at) VALUES ($1, $2, now(), $3, $4, now())', [id, email, opts.password ? 'hashed' : '', user.created_at]);
    if (opts.google) await q("INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ($1, 'google', $2::jsonb)", [id, JSON.stringify({ email })]);
    return user;
  };
  /** Google linked to an existing login, as Supabase does it, in both places the app reads. */
  const linkGoogle = async (user: AuthUser) => {
    user.identities.push(googleIdentity(user.id, user.email));
    await q("INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ($1, 'google', $2::jsonb)", [user.id, JSON.stringify({ email: user.email })]);
  };
  /**
   * The callback as Google returns to it: a code, the code verifier cookie
   * @supabase/ssr keeps, and the intent cookie (made up here, as a browser
   * could). Answers where it sends the browser.
   */
  const callback = async (intent: import('../src/lib/api/google-intent').GoogleIntent, as: AuthUser) => {
    const { encodeGoogleIntent, GOOGLE_INTENT_COOKIE } = await import('../src/lib/api/google-intent');
    calls.exchangeAs = as;
    const storageKey = `sb-${new URL(server.url).hostname.split('.')[0]}-auth-token`;
    const jar = [
      { name: GOOGLE_INTENT_COOKIE, value: encodeGoogleIntent(intent) },
      { name: `${storageKey}-code-verifier`, value: 'verifier-123' },
    ];
    const store = { getAll: () => jar, get: (key: string) => jar.find((cookie) => cookie.name === key), set: () => undefined, delete: () => undefined };
    (createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> }).cookies = async () => store;
    const { GET } = await import('../src/app/auth/callback/route');
    const { NextRequest } = await import('next/server');
    const response = await GET(new NextRequest(`${APP_URL}/auth/callback?code=google-code`));
    return response.headers.get('location') ?? '';
  };
  /** The user as supabase-js hands it to the callback. */
  const asUser = (user: AuthUser) => ({ id: user.id, email: user.email, created_at: user.created_at, user_metadata: user.meta, identities: user.identities as never });
  const memberRow = async (authUserId: string) => (await q<{ id: string; avatar: string; role: string; login_owned: boolean; status: string }>(
    'SELECT id, avatar, role, login_owned, status FROM pm.team_members WHERE auth_user_id = $1', [authUserId]))[0];

  try {
    const lib = await import('../src/lib/sign-in');
    const signInServer = await import('../src/lib/api/sign-in');
    const firstOwner = await import('../src/lib/setup/first-owner');
    const invite = await import('../src/lib/team/invite');
    const { NOT_OUR_LOGIN } = await import('../src/lib/team/invite-rules');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    // ---- The setting: email and password until an Owner says otherwise ----------
    const stored = await q<{ sign_in_methods: string }>('SELECT sign_in_methods FROM pm.business_settings');
    check('default: a fresh install offers email and password, or Google', stored.length === 1 && stored[0].sign_in_methods === 'both', stored);
    check('default: the constant agrees', lib.DEFAULT_SIGN_IN_METHODS === 'both');
    const read = await signInServer.readSignInMethods(service);
    check('default: the server reads both, migration present', read.methods === 'both' && read.ready === true, read);
    check('default: an unknown stored value reads as both', lib.parseSignInMethods('magic-link') === 'both' && lib.parseSignInMethods(null) === 'both');
    const insertedDefault = await q<{ sign_in_methods: string }>("SELECT column_default AS sign_in_methods FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'business_settings' AND column_name = 'sign_in_methods'");
    check('default: the column default is both', /'both'/.test(insertedDefault[0]?.sign_in_methods ?? ''), insertedDefault);
    const bad = await attempt(() => q("UPDATE pm.business_settings SET sign_in_methods = 'magic'"));
    check('setting: the database stores only password, google or both', !!bad.error, bad.error?.message);
    check('page: password only shows no Google button', JSON.stringify(lib.signInChoices('password', 'on')) === JSON.stringify({ google: false, password: true }));
    check('page: both shows both', JSON.stringify(lib.signInChoices('both', 'on')) === JSON.stringify({ google: true, password: true }));
    check('page: Google only hides the password form', JSON.stringify(lib.signInChoices('google', 'on')) === JSON.stringify({ google: true, password: false }));
    check('page: Google only with Google off in Supabase keeps the password form', JSON.stringify(lib.signInChoices('google', 'off')) === JSON.stringify({ google: false, password: true }));
    check('page: the default with Google off shows email and password only', JSON.stringify(lib.signInChoices('both', 'off')) === JSON.stringify({ google: false, password: true }));
    check('page: never a Google button that may not work (provider unknown)', JSON.stringify(lib.signInChoices('both', 'unknown')) === JSON.stringify({ google: false, password: true }));

    // ---- The sign-in page itself, as the server builds it and as it renders -------------
    const { default: LoginPage } = await import('../src/app/(auth)/login/page');
    const { LoginView } = await import('../src/app/(auth)/login/LoginForm');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const pageChoices = async () => {
      signInServer.resetGoogleProviderCache();
      const element = await LoginPage({ searchParams: Promise.resolve({}) }) as { props: { password: boolean; google: boolean } };
      return { google: element.props.google, password: element.props.password };
    };
    check('login page: the default with Google on in Supabase shows both', JSON.stringify(await pageChoices()) === JSON.stringify({ google: true, password: true }));
    await q("UPDATE pm.business_settings SET sign_in_methods = 'google'");
    check('login page: Google only shows Google alone', JSON.stringify(await pageChoices()) === JSON.stringify({ google: true, password: false }));
    calls.googleOn = false;
    check('login page: with Google off in Supabase it shows email and password only, whatever the setting', JSON.stringify(await pageChoices()) === JSON.stringify({ google: false, password: true }));
    await q("UPDATE pm.business_settings SET sign_in_methods = 'both'");
    check('login page: and the default with Google off shows email and password only', JSON.stringify(await pageChoices()) === JSON.stringify({ google: false, password: true }));
    calls.googleOn = true;
    signInServer.resetGoogleProviderCache();
    const render = (choices: { password: boolean; google: boolean }) => renderToStaticMarkup(createElement(LoginView, {
      ...choices, error: '', email: '', passwordValue: '', loading: false, googleBusy: false,
      onEmail: () => undefined, onPassword: () => undefined, onSubmit: () => undefined, onGoogle: () => undefined,
    }));
    const googleOnlyHtml = render({ google: true, password: false });
    check('login view: Google only has the Google button', googleOnlyHtml.includes('Continue with Google'), googleOnlyHtml);
    check('login view: Google only has no input fields and no submit button', !/<input/i.test(googleOnlyHtml) && !/type="submit"/.test(googleOnlyHtml), googleOnlyHtml);
    check('login view: Google only offers no password reset', !googleOnlyHtml.includes('Forgot password'), googleOnlyHtml);
    const passwordHtml = render({ google: false, password: true });
    check('login view: password only has the form and no Google button', /<input[^>]*type="email"/.test(passwordHtml) && /type="submit"/.test(passwordHtml) && !passwordHtml.includes('Continue with Google'), passwordHtml);
    check('login view: with passwords there is a Forgot password? link to the reset page', /href="\/login\/forgot"[^>]*>Forgot password\?<\/a>/.test(passwordHtml), passwordHtml);
    const bothHtml = render({ google: true, password: true });
    check('login view: both shows Google, then or, then the form', bothHtml.indexOf('Continue with Google') < bothHtml.indexOf('>or<') && bothHtml.indexOf('>or<') < bothHtml.indexOf('type="email"'), bothHtml);

    // ---- The setting screen: what can be chosen ------------------------------------------
    const owns = { ownGoogle: true, ownPassword: true };
    check('setting screen: with Google off in Supabase, both Google choices are unavailable with how to turn it on',
      lib.methodUnavailable('both', { provider: 'off', ...owns }) === lib.GOOGLE_PROVIDER_OFF && lib.methodUnavailable('google', { provider: 'off', ...owns }) === lib.GOOGLE_PROVIDER_OFF);
    check('setting screen: email and password stays available with Google off', lib.methodUnavailable('password', { provider: 'off', ...owns }) === null);
    check('setting screen: Google only waits for the Owner\'s own Google', lib.methodUnavailable('google', { provider: 'on', ownGoogle: false, ownPassword: true }) === lib.OWNER_LINK_GOOGLE_FIRST);
    check('setting screen: email and password only waits for the Owner\'s own password', lib.methodUnavailable('password', { provider: 'on', ownGoogle: true, ownPassword: false }) === lib.OWNER_SET_PASSWORD_FIRST);
    check('setting screen: both is available with Google on', lib.methodUnavailable('both', { provider: 'on', ownGoogle: false, ownPassword: false }) === null);
    check('provider: read from the public auth settings', (await signInServer.googleProviderState()) === 'on');

    // ---- Where to go after signing in: a path on this site, nothing else ----------
    const { safeNextPath } = await import('../src/lib/supabase/next-path');
    const { decodeGoogleIntent, encodeGoogleIntent } = await import('../src/lib/api/google-intent');
    const offsite = ['/\t/evil.com', '/\n/evil.com', '/\r\n/evil.com', '/\t\\evil.com', '/\\evil.com', '//evil.com', 'https://evil.com/x', 'evil.com', '/\u0000/evil.com'];
    for (const value of offsite) check(`next: ${JSON.stringify(value)} is refused`, safeNextPath(value) === null, safeNextPath(value));
    check('next: a path on this site is kept, query and all', safeNextPath('/projects/abc?tab=tasks&task=1') === '/projects/abc?tab=tasks&task=1');
    check('next: the sign-in page itself is refused', safeNextPath('/login?next=/x') === null);
    check('next: a made-up intent cookie cannot carry an offsite next',
      offsite.every((value) => { const intent = decodeGoogleIntent(encodeGoogleIntent({ kind: 'sign-in', next: value })); return intent.kind === 'sign-in' && intent.next === null; }));

    // ---- First Owner with Google: the setup code, before and after Google -------
    // A shared project: another app's user is already here.
    const hiUser = await addLogin('hi-user@example.com', { password: true, createdAt: '2026-01-01T00:00:00Z' });
    firstOwner.resetFirstOwnerCache();
    const noCodeOnHost = await attempt(() => firstOwner.startFirstOwnerGoogle(service, { name: 'Olive Owner' }, { env: {} }));
    check('first owner: with other logins and no code on the host, it says to add one', noCodeOnHost.error instanceof firstOwner.FirstOwnerError && noCodeOnHost.error.status === 409 && noCodeOnHost.error.field === 'setup_code', noCodeOnHost.error?.message);
    // A login left by an abandoned Google sign-in counts too: the words say so.
    check('first owner: the message covers an earlier sign-in attempt', /earlier sign-in attempt/.test(noCodeOnHost.error?.message ?? ''), noCodeOnHost.error?.message);
    const env = { [firstOwner.SETUP_CODE_ENV]: SETUP_CODE };
    const noCode = await attempt(() => firstOwner.startFirstOwnerGoogle(service, { name: 'Olive Owner' }, { env }));
    check('first owner: before Google, no code is refused (403 setup_code)', noCode.error instanceof firstOwner.FirstOwnerError && noCode.error.status === 403 && noCode.error.field === 'setup_code', noCode.error?.message);
    const wrongCode = await attempt(() => firstOwner.startFirstOwnerGoogle(service, { name: 'Olive Owner', setup_code: 'guess' }, { env }));
    check('first owner: before Google, a wrong code is refused', wrongCode.error instanceof firstOwner.FirstOwnerError && wrongCode.error.status === 403, wrongCode.error?.message);
    const started = await firstOwner.startFirstOwnerGoogle(service, { name: ' Olive Owner ', setup_code: SETUP_CODE }, { env });
    check('first owner: the right code passes and the name is trimmed', started.name === 'Olive Owner' && started.setupCode === SETUP_CODE, started);
    const startedAt = Date.now() - 1000;
    // Google signs them in: a new login, made during the round trip.
    const olive = await addLogin('olive@gmail.com', { google: true, meta: { avatar_url: PHOTO, full_name: 'Olive' } });
    const skipped = await attempt(() => firstOwner.claimFirstOwnerWithGoogle(service, { user: asUser(olive), name: 'Olive Owner', setupCode: '', startedAt }, { env }));
    check('first owner: after Google, a claim without the code is refused (step one cannot be skipped)', skipped.error instanceof firstOwner.FirstOwnerError && skipped.error.field === 'setup_code', skipped.error?.message);
    const forged = await attempt(() => firstOwner.claimFirstOwnerWithGoogle(service, { user: asUser(olive), name: 'Olive Owner', setupCode: 'forged', startedAt }, { env }));
    check('first owner: after Google, a wrong code is refused', forged.error instanceof firstOwner.FirstOwnerError && forged.error.status === 403, forged.error?.message);
    check('first owner: a refused claim adds nobody', (await q('SELECT 1 FROM pm.team_members')).length === 0);
    // Google must stay on after the claim, or the new Owner could not sign in again: if that write fails, nothing is claimed.
    await q("UPDATE pm.business_settings SET sign_in_methods = 'password'");
    await q("ALTER TABLE pm.business_settings ADD CONSTRAINT test_no_both CHECK (sign_in_methods <> 'both')");
    const noGoogleAfter = await attempt(() => firstOwner.claimFirstOwnerWithGoogle(service, { user: asUser(olive), name: 'Olive Owner', setupCode: SETUP_CODE, startedAt }, { env }));
    await q('ALTER TABLE pm.business_settings DROP CONSTRAINT test_no_both');
    check('first owner: a claim that cannot keep Google on fails', noGoogleAfter.error instanceof firstOwner.FirstOwnerError, noGoogleAfter.error?.message ?? 'claimed');
    check('first owner: and makes nobody the Owner', (await q('SELECT 1 FROM pm.team_members')).length === 0);
    const claimed = await firstOwner.claimFirstOwnerWithGoogle(service, { user: asUser(olive), name: 'Olive Owner', setupCode: SETUP_CODE, startedAt }, { env });
    const oliveRow = await memberRow(olive.id);
    check('first owner: the claim binds the Owner to the signed-in Google user', claimed.email === 'olive@gmail.com' && oliveRow?.role === 'owner', { claimed, oliveRow });
    check('first owner: a login made during the round trip is the app\'s own (login_owned true)', oliveRow?.login_owned === true, oliveRow);
    check('first owner: Google stays on for sign-in (both)', (await signInServer.readSignInMethods(service)).methods === 'both');
    // The new Owner has Google and no password: email and password only would lock them out.
    const lockout = await attempt(() => signInServer.setSignInMethods(service, { authUserId: olive.id }, 'password'));
    check('setting: email and password only is refused while the Owner has no password (409)',
      (lockout.error as { statusCode?: number } | null)?.statusCode === 409 && lockout.error?.message === signInServer.SET_PASSWORD_FIRST_OWNER, lockout.error?.message);
    check('setting: and the setting is unchanged', (await signInServer.readSignInMethods(service)).methods === 'both');
    const again = await attempt(() => firstOwner.claimFirstOwnerWithGoogle(service, { user: asUser(hiUser), name: 'Late', setupCode: SETUP_CODE, startedAt }, { env }));
    check('first owner: once claimed, a second claim is refused', again.error?.message === firstOwner.ALREADY_OWNED, again.error?.message);
    // The callback then admits them: the member made through Google starts with the Google photo.
    check('avatar: the Owner made through Google is admitted', (await signInServer.admitGoogleLogin(service, asUser(olive))) === oliveRow?.id);
    check('avatar: and starts with the Google photo', (await memberRow(olive.id))?.avatar === PHOTO, await memberRow(olive.id));

    // ---- The roster gate -----------------------------------------------------------
    const stranger = await addLogin('stranger@gmail.com', { google: true, meta: { avatar_url: PHOTO } });
    check('gate: a Google login with no member row is refused', (await signInServer.activeMemberId(service, stranger.id)) === null);
    check('gate: and admitting it adds nobody', (await signInServer.admitGoogleLogin(service, asUser(stranger))) === null && !(await memberRow(stranger.id)));
    const owner = (await resolveMemberAccess(service, oliveRow!.id))!;
    const base = { service, appUrl: APP_URL, inviterName: 'Olive Owner', mailer: async () => ({ success: true }) };
    const sus = await invite.inviteMember({ ...base, access: owner, input: { name: 'Sue', email: 'sue@example.com', role: 'member' } });
    await q(`UPDATE pm.team_members SET status = 'suspended' WHERE id = $1`, [sus.member.id]);
    const sueAuth = [...users.values()].find((u) => u.email === 'sue@example.com')!;
    check('gate: a suspended member is refused', (await signInServer.activeMemberId(service, sueAuth.id)) === null);
    check('gate: an active member gets in', (await signInServer.activeMemberId(service, olive.id)) === oliveRow?.id);

    // ---- Accepting an invite with Google ----------------------------------------------
    const maya = await invite.inviteMember({ ...base, access: owner, input: { name: 'Maya', email: 'maya@example.com', role: 'member' } });
    const token = new URL(maya.invite!.link).searchParams.get('token')!;
    const mayaAuth = [...users.values()].find((u) => u.email === 'maya@example.com')!;
    const used = async () => (await q<{ used_at: string | null }>('SELECT used_at FROM pm.team_invites WHERE member_id = $1', [maya.member.id]))[0]?.used_at;
    const otherEmail = await attempt(() => invite.acceptInviteWithGoogle(service, { token, userId: mayaAuth.id, googleEmail: 'maya.personal@gmail.com' }));
    check('invite: a Google account with a different email is refused', otherEmail.error instanceof invite.GoogleInviteError && otherEmail.error.code === 'invite_email', otherEmail.error?.message);
    check('invite: and the link is not used up', !(await used()));
    const separate = await addLogin('maya@example.com.separate', { google: true });
    const otherLogin = await attempt(() => invite.acceptInviteWithGoogle(service, { token, userId: separate.id, googleEmail: 'MAYA@example.com' }));
    check('invite: the same email on a separate login is never linked', otherLogin.error instanceof invite.GoogleInviteError && otherLogin.error.code === 'invite_other_login', otherLogin.error?.message);
    check('invite: and the invited member still points at the invited login', (await memberRow(mayaAuth.id))?.id === maya.member.id && !(await memberRow(separate.id)));
    // Supabase linked Google to the invited login (same confirmed email).
    await linkGoogle(mayaAuth);
    mayaAuth.meta = { picture: 'https://lh3.googleusercontent.com/a/maya' };
    const accepted = await invite.acceptInviteWithGoogle(service, { token, userId: mayaAuth.id, googleEmail: ' Maya@Example.com ' });
    check('invite: the matching Google account accepts it (email compared without case)', accepted.memberId === maya.member.id, accepted);
    check('invite: the link is used up', !!(await used()));
    const twice = await attempt(() => invite.acceptInviteWithGoogle(service, { token, userId: mayaAuth.id, googleEmail: 'maya@example.com' }));
    check('invite: a used link is refused', twice.error instanceof invite.GoogleInviteError && twice.error.code === 'invite_expired', twice.error?.message);
    check('avatar: a member who joined with Google starts with the photo (picture)', (await signInServer.admitGoogleLogin(service, asUser(mayaAuth))) === maya.member.id
      && (await memberRow(mayaAuth.id))?.avatar === 'https://lh3.googleusercontent.com/a/maya', await memberRow(mayaAuth.id));

    // ---- The callback: the gate, Google off, and where it sends people -------------------
    const signOutsBefore = calls.signOuts;
    const home = await callback({ kind: 'sign-in', next: '/\t/evil.com' }, olive);
    check('callback: a member gets in, and a made-up offsite next lands on the dashboard', home === `${APP_URL}/dashboard`, home);
    const deep = await callback({ kind: 'sign-in', next: '/projects/abc?tab=tasks' }, olive);
    check('callback: a next on this site is followed', deep === `${APP_URL}/projects/abc?tab=tasks`, deep);
    const refused = await callback({ kind: 'sign-in', next: null }, stranger);
    check('callback: a Google login with no member row is signed out with no access', refused === `${APP_URL}/login?error=no_access` && calls.signOuts === signOutsBefore + 1, { refused, signOuts: calls.signOuts });
    await q("UPDATE pm.business_settings SET sign_in_methods = 'password'");
    const forgedLink = await callback({ kind: 'link' }, olive);
    const forgedSignIn = await callback({ kind: 'sign-in', next: null }, olive);
    await q("UPDATE pm.business_settings SET sign_in_methods = 'both'");
    check('callback: a made-up link intent cannot get past Google being off', forgedLink === `${APP_URL}/settings/account?google=google_off`, forgedLink);
    check('callback: nor can a plain Google sign-in', forgedSignIn === `${APP_URL}/login?error=google_off`, forgedSignIn);
    const { POST: startGoogle } = await import('../src/app/api/auth/google/route');
    const { NextRequest } = await import('next/server');
    const startedSignIn = await startGoogle(new NextRequest(`${APP_URL}/api/auth/google`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'sign-in', next: '/\t/evil.com' }),
    }));
    const { GOOGLE_INTENT_COOKIE } = await import('../src/lib/api/google-intent');
    const kept = decodeGoogleIntent(startedSignIn.cookies.get(GOOGLE_INTENT_COOKIE)?.value);
    check('start: an offsite next is dropped before it reaches the cookie', startedSignIn.status === 200 && kept.kind === 'sign-in' && kept.next === null, { status: startedSignIn.status, kept });

    // ---- The Google photo never replaces one the member set -----------------------------
    const pat = await invite.inviteMember({ ...base, access: owner, input: { name: 'Pat', email: 'pat@example.com', role: 'member' } });
    const patAuth = [...users.values()].find((u) => u.email === 'pat@example.com')!;
    await linkGoogle(patAuth);
    patAuth.meta = { avatar_url: 'https://lh3.googleusercontent.com/a/pat-google' };
    check('avatar: an empty avatar is filled', await signInServer.fillAvatarFromGoogle(service, pat.member.id, asUser(patAuth))
      && (await memberRow(patAuth.id))?.avatar === 'https://lh3.googleusercontent.com/a/pat-google');
    await q('UPDATE pm.team_members SET avatar = $1 WHERE id = $2', ['https://cdn.example.com/avatars/pat-uploaded.png', pat.member.id]);
    const keptFilled = await signInServer.fillAvatarFromGoogle(service, pat.member.id, asUser(patAuth));
    check('avatar: an uploaded photo is kept', !keptFilled && (await memberRow(patAuth.id))?.avatar === 'https://cdn.example.com/avatars/pat-uploaded.png', await memberRow(patAuth.id));
    // The member set the Google address themselves, then Google's photo changes: still theirs.
    await q('UPDATE pm.team_members SET avatar = $1 WHERE id = $2', ['https://lh3.googleusercontent.com/a/pat-google', pat.member.id]);
    patAuth.meta = { avatar_url: 'https://lh3.googleusercontent.com/a/pat-google-new' };
    await signInServer.admitGoogleLogin(service, asUser(patAuth));
    check('avatar: one that equals a Google address is still never replaced', (await memberRow(patAuth.id))?.avatar === 'https://lh3.googleusercontent.com/a/pat-google', await memberRow(patAuth.id));
    check('avatar: only an https photo counts', signInServer.googlePhotoOf({ user_metadata: { avatar_url: 'javascript:alert(1)' }, identities: [] }) === null);

    // ---- A member's own sign-in: always one way in ----------------------------------------
    const facts = (over: Partial<import('../src/lib/sign-in').AccountFacts>) => ({ loginOwned: true, hasPassword: true, googleLinked: true, methods: 'both' as const, ...over });
    check('unlink: refused when Google is the only way in (no password)', lib.accountChangeRefusal(facts({ hasPassword: false }), 'unlink_google') === lib.SET_PASSWORD_FIRST);
    check('unlink: refused on a Google-only workspace', lib.accountChangeRefusal(facts({ methods: 'google' }), 'unlink_google') === lib.GOOGLE_ONLY_WORKSPACE);
    check('unlink: allowed with a password the workspace accepts', lib.accountChangeRefusal(facts({}), 'unlink_google') === null);
    // Through the server, with the password read from the login itself (pm.login_has_password).
    const mayaMember = { memberId: maya.member.id, authUserId: mayaAuth.id };
    const noPassword = await attempt(() => signInServer.assertAccountChange(service, mayaMember, 'unlink_google'));
    check('unlink: the server refuses unlinking Maya\'s only way in (409)', (noPassword.error as { statusCode?: number } | null)?.statusCode === 409 && noPassword.error?.message === lib.SET_PASSWORD_FIRST, noPassword.error?.message);
    await q("UPDATE auth.users SET encrypted_password = 'hashed' WHERE id = $1", [mayaAuth.id]);
    check('unlink: with a password set, the server allows it', (await attempt(() => signInServer.assertAccountChange(service, mayaMember, 'unlink_google'))).error === null);

    // ---- A login another app made ------------------------------------------------------------
    const hiRow = (await q<{ id: string }>('SELECT (pm.add_team_member($1, $2, $3, $4, $5)).id', [hiUser.id, hiUser.email, 'Hal', 'member', false]))[0];
    await q(`UPDATE pm.team_members SET status = 'active' WHERE id = $1`, [hiRow.id]);
    const hal = { memberId: hiRow.id, authUserId: hiUser.id };
    const halView = await signInServer.accountSignInView(service, hal);
    check('other app\'s login: its password is not PM\'s to change', halView.refusals.set_password === NOT_OUR_LOGIN && !halView.login_owned, halView);
    check('other app\'s login: nor its email', halView.refusals.change_email === NOT_OUR_LOGIN, halView.refusals);
    check('other app\'s login: linking Google to it is fine', halView.refusals.link_google === null, halView.refusals);
    check('other app\'s login: rule agrees for unlinking (its link stays)', lib.accountChangeRefusal(facts({ loginOwned: false }), 'unlink_google') === NOT_OUR_LOGIN);
    const { PUT: setPassword } = await import('../src/app/api/workspace/me/sign-in/password/route');
    const putPassword = (password: string) => setPassword(new Request('http://localhost/api/workspace/me/sign-in/password', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    }));
    signInAs(server.url, hiUser.id, hiUser.email);
    const halPut = await putPassword('a-new-password');
    const halBody = await halPut.json();
    check('other app\'s login: the password route refuses it (409)', halPut.status === 409 && halBody.error?.message === NOT_OUR_LOGIN, { status: halPut.status, halBody });
    check('other app\'s login: and its password never reached Supabase', !calls.passwordChanges.includes(hiUser.id), calls.passwordChanges);
    signInAs(server.url, olive.id, olive.email);
    const olivePut = await putPassword('olive-password-1');
    const oliveBody = await olivePut.json();
    check('own login: the password route sets it through the session', olivePut.status === 200 && calls.passwordChanges.includes(olive.id) && oliveBody.data?.has_password === true, { status: olivePut.status, oliveBody });
    const shortPut = await putPassword('short');
    check('own login: a short password is refused before Supabase', shortPut.status === 422);

    // ---- Forgot password: the same answer for everyone, and never another app's login -------
    const { POST: resetPost } = await import('../src/app/api/auth/reset/route');
    const { NextRequest: ResetRequest } = await import('next/server');
    const askReset = async (email: string) => {
      const response = await resetPost(new ResetRequest(`${APP_URL}/api/auth/reset`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${email.length}` }, body: JSON.stringify({ email }),
      }));
      return { status: response.status, body: await response.text(), cookie: response.headers.get('set-cookie') };
    };
    const answers = await Promise.all(['nobody@example.com', stranger.email, olive.email, hiUser.email].map(askReset));
    check('reset: every email gets the same answer (status, words, no cookie)', answers.every((a) => a.status === 200 && a.body === answers[0].body && a.cookie === null), answers);
    check('reset: the answer says if that email can sign in, a link was sent', answers[0].body.includes('If that email can sign in here, we sent a link'), answers[0].body);
    const settle = async () => { for (let i = 0; i < 40 && calls.recoveries.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50)); };
    await settle();
    const sentTo = calls.recoveries.map((r) => r.email).sort();
    check('reset: a link goes only to members (not to unknown emails or logins off the team)', JSON.stringify(sentTo) === JSON.stringify([hiUser.email, olive.email].sort()), calls.recoveries);
    check('reset: the link returns to the one allowed address', calls.recoveries.every((r) => r.redirectTo === `${APP_URL}/auth/callback`), calls.recoveries);
    const { GET: callbackGet } = await import('../src/app/auth/callback/route');
    const { NextRequest: CbRequest } = await import('next/server');
    const backFromEmail = (await callbackGet(new CbRequest(`${APP_URL}/auth/callback`))).headers.get('location');
    check('reset: back from the email link (no code, no error) the callback opens the reset page', backFromEmail === `${APP_URL}/welcome/reset-password`, backFromEmail);
    const halAfterClick = await signInServer.accountSignInView(service, hal);
    check('reset: after the link, a login another app made is told to use Google or that app (never a new password here)', lib.resetPageOutcome(halAfterClick) === 'managed_elsewhere', halAfterClick.refusals);
    check('reset: a PM login gets the new password form', lib.resetPageOutcome(await signInServer.accountSignInView(service, { memberId: oliveRow!.id, authUserId: olive.id })) === 'form');
    check('reset: no member, no form', lib.resetPageOutcome(null) === 'no_access');
    signInAs(server.url, hiUser.id, hiUser.email);
    const halReset = await putPassword('reset-attempt-1');
    check('reset: setting a password on another app\'s login is refused even with a reset session (409)', halReset.status === 409 && !calls.passwordChanges.includes(hiUser.id), halReset.status);
    calls.recoveries.length = 0;
    await q("UPDATE pm.business_settings SET sign_in_methods = 'google'");
    await askReset(olive.email);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await q("UPDATE pm.business_settings SET sign_in_methods = 'both'");
    check('reset: with Google only, no reset link is sent', calls.recoveries.length === 0, calls.recoveries);

    // ---- Who a change of methods would leave with no way in -----------------------------------
    // Olive and Maya now have a password and Google; Pat joined with Google only; Hal has only the other app's password.
    // Penny is invited and has not joined yet: she can still join either way, so she is never counted.
    await invite.inviteMember({ ...base, access: owner, input: { name: 'Penny Pending', email: 'penny@example.com', role: 'member' } });
    await q("UPDATE auth.users SET last_sign_in_at = NULL WHERE email = 'penny@example.com'");
    // Maya and Pat joined (with Google) after their invites.
    await q("UPDATE auth.users SET last_sign_in_at = now() WHERE email IN ('maya@example.com', 'pat@example.com')");
    const reach = (await signInServer.strandedByMethods(service))!;
    const names = (methods: 'password' | 'google' | 'both') => reach[methods].names.join(',');
    check('stranded: email and password only would leave Pat with no way in', reach.password.count === 1 && names('password') === 'Pat', reach.password);
    check('stranded: Google only would leave Hal with no way in', reach.google.count === 1 && names('google') === 'Hal', reach.google);
    check('stranded: both leaves nobody out', reach.both.count === 0, reach.both);
    check('stranded: a suspended member and a pending invite are not counted', !JSON.stringify(reach).includes('Sue') && !JSON.stringify(reach).includes('Penny'), reach);
    const { GET: getMethods } = await import('../src/app/api/workspace/sign-in-methods/route');
    signInAs(server.url, olive.id, olive.email);
    const methodsBody = await (await getMethods(new Request('http://localhost/api/workspace/sign-in-methods'))).json();
    check('stranded: the Owner sees it with the setting', methodsBody.data?.stranded?.password?.count === 1 && methodsBody.data?.stranded?.google?.names?.[0] === 'Hal', methodsBody);
    // Many people stranded: a count, and only the first few names.
    const many = lib.strandedSummary(Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, has_password: false, has_google: true })), 'password');
    check('stranded: past a few people it gives the count and the first names only', many.count === 8 && many.names.length === lib.STRANDED_NAME_LIMIT, many);
    const withPassword = await signInServer.setSignInMethods(service, { authUserId: olive.id }, 'password');
    check('setting: with a password of their own, the Owner can choose email and password only', withPassword.methods === 'password', withPassword);
    await signInServer.setSignInMethods(service, { authUserId: olive.id }, 'both');

    // ---- Google only waits for the Owner's own Google ---------------------------------------
    const hiOwnerless = await attempt(() => signInServer.setSignInMethods(service, { authUserId: hiUser.id }, 'google'));
    check('setting: Google only is refused until the Owner has Google linked', hiOwnerless.error?.message === signInServer.LINK_GOOGLE_FIRST, hiOwnerless.error?.message);
    const googleOnly = await signInServer.setSignInMethods(service, { authUserId: olive.id }, 'google');
    check('setting: an Owner with Google linked can choose Google only', googleOnly.methods === 'google', googleOnly);
    const { PUT: putMethods } = await import('../src/app/api/workspace/sign-in-methods/route');
    signInAs(server.url, mayaAuth.id, mayaAuth.email);
    const memberPut = await putMethods(new Request('http://localhost/api/workspace/sign-in-methods', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ methods: 'password' }) }));
    check('setting: a member cannot change it (403)', memberPut.status === 403 && (await signInServer.readSignInMethods(service)).methods === 'google', memberPut.status);
    await actAs(db, mayaAuth.id);
    const direct = await attempt(() => db.query("UPDATE pm.business_settings SET sign_in_methods = 'password'"));
    await db.exec('RESET ROLE');
    check('setting: nor straight in the database', !!direct.error || (await q<{ sign_in_methods: string }>('SELECT sign_in_methods FROM pm.business_settings'))[0].sign_in_methods === 'google', direct.error?.message);
    check('functions: the login facts are service only', (await q<{ ok: boolean }>("SELECT has_function_privilege('authenticated', 'pm.login_has_password(uuid)', 'EXECUTE') OR has_function_privilege('anon', 'pm.other_logins_exist(uuid)', 'EXECUTE') AS ok"))[0].ok === false);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`google sign-in: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`google sign-in: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
