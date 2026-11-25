/**
 * Connect AI (20261125000000_connect_ai.sql): OAuth 2.1 for the MCP server,
 * end to end over the real routes (the metadata documents, registration,
 * the consent route as a signed-in person, the token endpoint, the MCP
 * route, the tool catalog, Settings routes), a fake PostgREST over PGlite
 * with the full schema:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   the previous release's key and audit writes still work; the new
 *   functions and tables are the server's only; a connection's key keeps its
 *   access and is never rotated; only an Owner flips the switch.
 * - Metadata (RFC 9728, RFC 8414); registration with redirect checks and a
 *   rate limit; the code flow with PKCE (a bad verifier spends the code, a
 *   reused code revokes what it gave out); refresh rotation and reuse
 *   detection; a secret client.
 * - The MCP route takes the bearer token as that person: connect tools only,
 *   never admin tools even for an Owner; the 401 challenge; audit rows via
 *   mcp_oauth without tokens; other v1 routes refuse the token.
 * - Disconnect, suspension and the workspace switch stop tokens.
 * - The tool catalog (GET /api/v1/mcp/tools) for keys, tokens and act-for.
 *
 *   npm run -s test:connect-ai
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { CONNECT_SCOPES, connectAbilities, connectScopesFor, connectToolGuides, consentWords, isConnectAccessToken, redirectHost, redirectUriProblem } from '../src/lib/connect-ai';
import nextConfig from '../next.config';
import type { AccessContext } from '../src/lib/access-control';

const MIGRATION = '20261125000000_connect_ai.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- CONNECT AI (20261125000000_connect_ai.sql)';
const NEW_FUNCTIONS = ['oauth_sweep', 'oauth_rate_limit', 'oauth_revoke_grant', 'oauth_claim_code', 'oauth_create_grant', 'oauth_rotate_refresh', 'oauth_resolve_access'];
const NEW_TABLES = ['oauth_clients', 'oauth_grants', 'oauth_codes', 'oauth_tokens', 'oauth_rate_limit_windows'];
const APP = 'https://pm.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

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
  owner: { id: '00000000-0000-4000-8000-00000000f001', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000f002', email: 'ana@example.com' },
  ben: { id: '00000000-0000-4000-8000-00000000f003', email: 'ben@example.com' },
  admin: { id: '00000000-0000-4000-8000-00000000f004', email: 'ada@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-25T00:00:00Z' }));
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
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-25T00:00:00Z' };
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

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

// ── Pure ─────────────────────────────────────────────────────────────────

async function headerChecks() {
  const rules = (await nextConfig.headers?.()) ?? [];
  const denies = (source: string) => {
    const rule = rules.find((r) => r.source === source);
    const value = (key: string) => rule?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
    return value('Content-Security-Policy') === "frame-ancestors 'none'" && value('X-Frame-Options') === 'DENY';
  };
  check('framing: the consent page cannot be framed (CSP frame-ancestors none and X-Frame-Options DENY)', denies('/oauth/:path*'), rules);
  check('framing: nor can sign-in', denies('/login') && denies('/login/:path*'), rules);
  // The app frames its own email previews (/email-preview frames /api/email-preview), and an
  // install may frame the client portal, so the rule is not app-wide.
  check('framing: the rule is not app-wide (email previews and the portal may be framed)', !rules.some((r) => /^\/(:path\*|\(\.\*\))?$/.test(r.source)
    && r.headers.some((h) => /frame/i.test(h.key) || /frame-ancestors/.test(h.value))), rules.map((r) => r.source));
}

function pureChecks() {
  const evil = consentWords('Claude', 'https://evil.example/cb');
  check('consent: the heading names where it returns, next to the name', evil.title === 'Claude, returning to evil.example', evil);
  check('consent: it says the name is the app\'s own claim, and to allow only if they recognise where it returns', /call itself Claude/.test(evil.caution)
    && /evil\.example/.test(evil.caution) && /recognise/.test(evil.caution) && !/\u2014/.test(JSON.stringify(evil)), evil);
  check('consent: a tool on this computer reads plainly', consentWords('Claude Code', 'http://localhost:1/cb').title === 'Claude Code, returning to an app on this computer');

  for (const uri of [CALLBACK, 'http://localhost:33418/callback', 'http://127.0.0.1:5000/cb', 'http://[::1]:8080/cb', 'cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth']) {
    check(`redirects: ${uri} is accepted`, redirectUriProblem(uri) === null, redirectUriProblem(uri));
  }
  for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'http://evil.example.com/cb', 'https://claude.ai/cb#frag', 'https://user:pw@claude.ai/cb', 'not a url', 'file:///etc/passwd', 'vbscript:x', '']) {
    check(`redirects: ${uri || '(empty)'} is refused`, redirectUriProblem(uri) !== null);
  }
  check('redirects: the consent screen names where it goes back to', redirectHost(CALLBACK) === 'claude.ai' && redirectHost('http://localhost:1/cb') === 'an app on this computer' && redirectHost('cursor://x/y') === 'the cursor app');
  const owner: AccessContext = { member_id: 'o', role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
  const scopes = connectScopesFor(owner);
  check('scopes: an Owner\'s connection holds only the connect set', JSON.stringify(scopes) === JSON.stringify(CONNECT_SCOPES)
    && !scopes.some((s) => /api_keys|team\.|settings|agents|access|webhooks|audit/.test(s)), scopes);
  const guest: AccessContext = { member_id: 'g', role: 'guest', status: 'active', app_permissions: [], api_permissions: ['projects.read', 'tasks.read'], project_ids: [] };
  check('scopes: a guest\'s connection holds what they hold of it', JSON.stringify(connectScopesFor(guest)) === JSON.stringify(['projects.read', 'tasks.read']));
  check('scopes: plain words for the consent screen', connectAbilities(scopes).includes('Create tasks') && connectAbilities(['tasks.read']).length === 2);
  check('tokens: an access token is recognisable', isConnectAccessToken('pmat_abc') && !isConnectAccessToken('pk_live_abc') && !isConnectAccessToken(null));
  const guides = connectToolGuides(`${APP}/api/mcp`, 'Acme');
  check('guides: five tools, two or three steps each, commands carry the address', guides.length === 5 && guides.every((g) => g.steps.length >= 2 && g.steps.length <= 3)
    && guides.find((g) => g.id === 'claude-code')?.snippet?.text === `claude mcp add --transport http pm ${APP}/api/mcp`
    && guides.every((g) => !g.snippet || g.snippet.step < g.steps.length)
    && !JSON.stringify(guides).includes('\u2014'));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the Connect AI section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("-- ---------------------------------------------------------------------------\n-- API keys: a connection's key")).trim();
  check('schema.sql: the section mirrors the migration body', body.length > 1000 && SCHEMA_SQL.slice(at).includes(body));
  check('migration: business_settings is locked last', MIGRATION_SQL.lastIndexOf('ALTER TABLE pm.business_settings') > MIGRATION_SQL.lastIndexOf('CREATE TABLE IF NOT EXISTS pm.oauth_'));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => old.query(sql, params).then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  check('upgrade: Connect AI starts on', (await q<Loose>('SELECT connect_ai_enabled FROM pm.business_settings LIMIT 1'))[0]?.connect_ai_enabled === true);

  // What 2.0.27 writes still works.
  await actAs(old, null);
  check('upgrade: a 2.0.27 key insert (scoped) still works', (await fail(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Old key', 'pk_live', 'hash-old', $1, $1, '{tasks.read}', 'scoped')`, [person])) === null);
  check('upgrade: a 2.0.27 audit insert (no via) still works', (await fail("INSERT INTO pm.api_audit_log (method, endpoint, team_member_id, status_code) VALUES ('GET', '/api/v1/tasks', $1, 200)", [person])) === null);
  check('audit: via mcp_oauth is accepted, an unknown door is not', (await fail("INSERT INTO pm.api_audit_log (method, endpoint, status_code, via) VALUES ('POST', '/x', 200, 'mcp_oauth')")) === null
    && /via_check/.test(await fail("INSERT INTO pm.api_audit_log (method, endpoint, status_code, via) VALUES ('POST', '/x', 200, 'smoke')") ?? ''));
  // A connection's key keeps its access and is never rotated.
  const conn = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Claude', 'connection', 'connection:x', $1, $1, '{tasks.read}', 'connection') RETURNING id`, [person]))[0].id;
  check('keys: a connection\'s scopes cannot change', /connected app/.test(await fail("UPDATE pm.api_keys SET scopes = '{tasks.read,api_keys.manage_all}' WHERE id = $1", [conn]) ?? ''));
  check('keys: nor can a key become or stop being a connection\'s', /connected app/.test(await fail("UPDATE pm.api_keys SET permissions = 'scoped' WHERE id = $1", [conn]) ?? ''));
  check('keys: a connection\'s key is never rotated', /cannot be rotated/.test(await fail("SELECT pm.rotate_api_key($1, 'pk_live_x', 'hash-new', $2, NULL, 0)", [conn, person]) ?? ''));
  check('keys: it can still be revoked', (await fail('UPDATE pm.api_keys SET revoked_at = now() WHERE id = $1', [conn])) === null);
  await old.exec('RESET ROLE');

  const fnGrants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = ANY ($1)`, [NEW_FUNCTIONS]);
  check('grants: the new functions are the server\'s only', fnGrants.length === NEW_FUNCTIONS.length && fnGrants.every((g: Loose) => !g.anon && !g.auth && g.svc), fnGrants);
  const tableGrants = await q<Loose>(`SELECT t, bool_or(has_table_privilege(r, ('pm.' || t)::regclass, p)) AS any_access
    FROM unnest($1::text[]) t, unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p GROUP BY t`, [NEW_TABLES]);
  check('grants: browsers cannot read or write the OAuth tables', tableGrants.length === NEW_TABLES.length && tableGrants.every((g: Loose) => !g.any_access), tableGrants);

  // Only an Owner flips the switch from a signed-in session.
  const adminLogin = '00000000-0000-4000-8000-0000000fa001';
  const ownerLogin = '00000000-0000-4000-8000-0000000fa002';
  await q("INSERT INTO auth.users (id, email) VALUES ($1, 'a@example.com'), ($2, 'o@example.com')", [adminLogin, ownerLogin]);
  const adminId = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ('Admin', 'a@example.com', 'admin', $1) RETURNING id", [adminLogin]))[0].id;
  await q("INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ('Owner', 'o@example.com', 'owner', $1)", [ownerLogin]);
  // An admin who manages settings, so the row policy lets the update reach the column check.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'settings.manage', 'app', 'allow')", [adminId]);
  await actAs(old, adminLogin);
  const adminTry = await fail('UPDATE pm.business_settings SET connect_ai_enabled = false');
  const adminOther = await old.query("UPDATE pm.business_settings SET business_name = 'Acme' RETURNING id").then((r) => r.rows.length, (e: Error) => e.message);
  await actAs(old, ownerLogin);
  const ownerTry = await old.query('UPDATE pm.business_settings SET connect_ai_enabled = false RETURNING connect_ai_enabled').then((r) => r.rows as Loose[], (e: Error) => e.message);
  await old.exec('RESET ROLE');
  check('switch: an admin who manages settings cannot turn Connect AI off; an Owner can', /Only an Owner/.test(adminTry ?? '') && adminOther === 1
    && Array.isArray(ownerTry) && ownerTry.length === 1 && ownerTry[0].connect_ai_enabled === false, { adminTry, adminOther, ownerTry });
  await fresh.close();
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const ana = await member('Ana', 'member', LOGINS.ana);
  const ben = await member('Ben', 'member', LOGINS.ben);
  const admin = await member('Ada', 'admin', LOGINS.admin);
  const jeff = await member('Jeff', 'agent');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const site = await project('Site', [ana, jeff]);
  const secret = await project('Secret', [ben]);
  const task = async (projectId: string, title: string, assignees: string[] = []) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, $2, 'todo') RETURNING id", [projectId, title]))[0].id;
    for (const a of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, a]);
    return id;
  };
  const anaTask = await task(site, 'Write the launch post', [ana]);
  await task(secret, 'Hidden budget', [ben]);
  const key = async (memberId: string, scopes: string[]) => {
    const value = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(value).digest('hex'), memberId, scopes]);
    return value;
  };
  const keys = {
    owner: await key(owner, ['api_keys.manage_all', 'team.read', 'team.manage', 'tasks.read', 'projects.read', 'agents.act_for']),
    jeff: await key(jeff, ['tasks.read', 'projects.read', 'agents.act_for']),
  };
  // Jeff may act for people (agents.act_for on its API permissions).
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow')", [jeff]);
  return { q, owner, ana, ben, admin, jeff, site, secret, anaTask, keys };
}

async function main() {
  pureChecks();
  await headerChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: APP,
  });
  installSession(server.url);
  try {
    const prm = await import('../src/app/.well-known/oauth-protected-resource/route');
    const prmPath = await import('../src/app/.well-known/oauth-protected-resource/[...path]/route');
    const asm = await import('../src/app/.well-known/oauth-authorization-server/route');
    const registerRoute = await import('../src/app/api/oauth/register/route');
    const tokenRoute = await import('../src/app/api/oauth/token/route');
    const authorizeRoute = await import('../src/app/api/oauth/authorize/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const catalogRoute = await import('../src/app/api/v1/mcp/tools/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Keys = await import('../src/app/api/v1/api-keys/route');
    const connectionsRoute = await import('../src/app/api/workspace/me/connections/route');
    const connectionRoute = await import('../src/app/api/workspace/me/connections/[id]/route');
    const switchRoute = await import('../src/app/api/workspace/connect-ai/route');
    const keyEditRoute = await import('../src/app/api/workspace/api-keys/[id]/route');
    const keyRotateRoute = await import('../src/app/api/workspace/api-keys/[id]/rotate/route');
    const keyRevokeRoute = await import('../src/app/api/workspace/api-keys/[id]/revoke/route');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    let ip = 1;
    const nextIp = () => `203.0.113.${ip++}`;
    const get = (handler: (request: NextRequest, context: never) => Promise<Response>, path: string, params: Record<string, unknown> = {}) =>
      handler(new NextRequest(`${APP}${path}`), { params: Promise.resolve(params) } as never).then(read);
    const register = (body: unknown, from = '198.51.100.1') => registerRoute.POST(new NextRequest(`${APP}/api/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify(body),
    })).then(read);
    const token = (form: Record<string, string | undefined>, headers: Record<string, string> = {}) => tokenRoute.POST(new NextRequest(`${APP}/api/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp(), ...headers },
      body: new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined)).toString(),
    })).then(read);
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'content-type': 'application/json', origin: APP }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const authorize = (params: Record<string, string | undefined>, decision: 'allow' | 'deny' = 'allow') =>
      session(authorizeRoute.POST as never, 'POST', '/api/oauth/authorize', {}, { ...params, decision });
    const mcp = async (credential: { bearer?: string; key?: string; actFor?: string } | null, body: unknown) => read(await mcpRoute.POST(new NextRequest(`${APP}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
        ...(credential?.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}),
        ...(credential?.key ? { 'x-api-key': credential.key } : {}),
        ...(credential?.actFor ? { 'x-act-for': credential.actFor } : {}),
      },
      body: JSON.stringify(body),
    })));
    const toolsOf = async (credential: { bearer?: string; key?: string }) => {
      const answer = await mcp(credential, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      return { answer, names: ((answer.body?.result?.tools ?? []) as Loose[]).map((t) => t.name as string) };
    };
    const callTool = (bearer: string, name: string, args: Record<string, unknown>) =>
      mcp({ bearer }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }).then((a) => a.body?.result?.structuredContent as Loose);

    // ── Metadata ──────────────────────────────────────────────────────
    const resource = await get(prm.GET as never, '/.well-known/oauth-protected-resource');
    const resourcePath = await get(prmPath.GET as never, '/.well-known/oauth-protected-resource/api/mcp', { path: ['api', 'mcp'] });
    const otherPath = await get(prmPath.GET as never, '/.well-known/oauth-protected-resource/other', { path: ['other'] });
    check('metadata: protected resource (RFC 9728) names the MCP server, this app and the scope', resource.status === 200 && resource.body.resource === `${APP}/api/mcp`
      && JSON.stringify(resource.body.authorization_servers) === JSON.stringify([APP]) && resource.body.scopes_supported?.[0] === 'connect'
      && JSON.stringify(resourcePath.body) === JSON.stringify(resource.body) && otherPath.status === 404, [resource.body, otherPath.status]);
    const meta = (await get(asm.GET as never, '/.well-known/oauth-authorization-server')).body;
    check('metadata: authorization server (RFC 8414) with PKCE S256, refresh tokens, registration and iss', meta.issuer === APP && meta.authorization_endpoint === `${APP}/oauth/authorize`
      && meta.token_endpoint === `${APP}/api/oauth/token` && meta.registration_endpoint === `${APP}/api/oauth/register`
      && JSON.stringify(meta.code_challenge_methods_supported) === '["S256"]' && meta.grant_types_supported.includes('refresh_token')
      && meta.token_endpoint_auth_methods_supported.includes('none') && meta.authorization_response_iss_parameter_supported === true, meta);

    // ── 401 challenge ─────────────────────────────────────────────────
    const bare = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const challenge = bare.headers.get('www-authenticate') ?? '';
    check('challenge: no credentials is 401 with resource_metadata and scope', bare.status === 401
      && challenge.includes(`resource_metadata="${APP}/.well-known/oauth-protected-resource/api/mcp"`) && challenge.includes('scope="connect"') && !challenge.includes('invalid_token'), challenge);
    const badToken = await mcp({ bearer: 'pmat_nope' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    check('challenge: a token that is not live is 401 invalid_token', badToken.status === 401 && /error="invalid_token"/.test(badToken.headers.get('www-authenticate') ?? ''), badToken.headers.get('www-authenticate'));
    const badKey = await mcp({ key: 'pk_live_nope' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    check('challenge: a bad API key is still 401 invalid_api_key (old contract), with the challenge', badKey.status === 401 && badKey.body?.error?.data?.reason === 'invalid_api_key' && !!badKey.headers.get('www-authenticate'));

    // ── Registration ──────────────────────────────────────────────────
    const reg = await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    const clientId: string = reg.body?.client_id;
    check('register: a public client (RFC 7591) gets an id and no secret', reg.status === 201 && /^pmc_[0-9a-f]{32}$/.test(clientId) && !('client_secret' in reg.body)
      && reg.body.token_endpoint_auth_method === 'none' && reg.headers.get('cache-control') === 'no-store', reg.body);
    for (const [label, body, error] of [
      ['javascript:', { redirect_uris: ['javascript:alert(1)'], token_endpoint_auth_method: 'none' }, 'invalid_redirect_uri'],
      ['plain http elsewhere', { redirect_uris: ['http://evil.example.com/cb'], token_endpoint_auth_method: 'none' }, 'invalid_redirect_uri'],
      ['no redirect', { redirect_uris: [], token_endpoint_auth_method: 'none' }, 'invalid_redirect_uri'],
      ['eleven redirects', { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`), token_endpoint_auth_method: 'none' }, 'invalid_redirect_uri'],
      ['an unknown auth method', { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
      ['the implicit grant', { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['implicit'] }, 'invalid_client_metadata'],
      ['response_type token', { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', response_types: ['token'] }, 'invalid_client_metadata'],
    ] as const) {
      const refused = await register(body);
      check(`register: ${label} is refused (${error})`, refused.status === 400 && refused.body?.error === error, refused.body);
    }
    const local = await register({ client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'], token_endpoint_auth_method: 'none' });
    check('register: a loopback http redirect for a tool on this computer is fine', local.status === 201);
    const secretReg = await register({ client_name: 'Gateway', redirect_uris: ['https://gateway.example.com/cb'] });
    check('register: left out, the auth method is client_secret_basic with a secret shown once', secretReg.status === 201 && secretReg.body.token_endpoint_auth_method === 'client_secret_basic'
      && /^pmcs_/.test(secretReg.body.client_secret ?? ''), secretReg.body);
    const stored = (await s.q<Loose>('SELECT client_secret_hash FROM pm.oauth_clients WHERE client_id = $1', [secretReg.body.client_id]))[0];
    check('register: only the secret\'s hash is stored', stored.client_secret_hash === createHash('sha256').update(secretReg.body.client_secret).digest('hex'));
    let limited: Answer | null = null;
    for (let i = 0; i < 21; i++) limited = await register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }, '192.0.2.77');
    check('register: 20 an hour per address, then 429 slow_down', limited?.status === 429 && limited.body?.error === 'slow_down', limited?.body);

    // ── Authorization (the consent route) ────────────────────────────
    const ask = (p: { challenge: string }, extra: Record<string, string | undefined> = {}) => ({
      response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: p.challenge, code_challenge_method: 'S256',
      state: 'st-1', scope: 'connect', resource: `${APP}/api/mcp`, ...extra,
    });
    as(LOGINS.ana);
    const p1 = pkce();
    const allowed = await authorize(ask(p1));
    const back = allowed.body?.redirect ? new URL(allowed.body.redirect) : null;
    const code1 = back?.searchParams.get('code') ?? '';
    check('authorize: Allow sends the person back with a one-time code, the state and iss', allowed.status === 200 && back?.origin === 'https://claude.ai'
      && /^pmac_/.test(code1) && back.searchParams.get('state') === 'st-1' && back.searchParams.get('iss') === APP, allowed.body);
    const denied = await authorize(ask(pkce()), 'deny');
    check('authorize: Deny sends back error=access_denied', new URL(denied.body?.redirect ?? 'x:/').searchParams.get('error') === 'access_denied', denied.body);
    const badRedirect = await authorize(ask(pkce(), { redirect_uri: 'https://evil.example.com/cb' }));
    check('authorize: a redirect_uri nobody registered goes nowhere (400, no redirect)', badRedirect.status === 400 && !badRedirect.body?.redirect, badRedirect.body);
    const unknownClient = await authorize(ask(pkce(), { client_id: 'pmc_0000' }));
    check('authorize: an unknown client goes nowhere', unknownClient.status === 400 && !unknownClient.body?.redirect);
    const noPkce = await authorize(ask(pkce(), { code_challenge: undefined }));
    const plain = await authorize(ask(pkce(), { code_challenge_method: 'plain' }));
    check('authorize: PKCE S256 is required (missing or plain is invalid_request)', new URL(noPkce.body.redirect).searchParams.get('error') === 'invalid_request'
      && new URL(plain.body.redirect).searchParams.get('error') === 'invalid_request', [noPkce.body, plain.body]);
    const wrongResource = await authorize(ask(pkce(), { resource: 'https://other.example.com/mcp' }));
    check('authorize: a resource that is not this MCP server is invalid_target', new URL(wrongResource.body.redirect).searchParams.get('error') === 'invalid_target');
    const foreign = await read(await authorizeRoute.POST(new NextRequest(`${APP}/api/oauth/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ ...ask(pkce()), decision: 'allow' }),
    })));
    check('authorize: the consent answer from another site\'s page is refused (403, no code)', foreign.status === 403 && !foreign.body?.redirect, foreign.body);
    const codeRows = await s.q<Loose>('SELECT code_hash, expires_at, created_at FROM pm.oauth_codes');
    check('authorize: codes are stored hashed and last about 60 seconds', codeRows.length === 1 && codeRows[0].code_hash === createHash('sha256').update(code1).digest('hex')
      && Math.abs(new Date(codeRows[0].expires_at).getTime() - new Date(codeRows[0].created_at).getTime() - 60_000) < 5_000, codeRows);

    // ── Token: code + PKCE ────────────────────────────────────────────
    const badVerifier = await token({ grant_type: 'authorization_code', code: code1, redirect_uri: CALLBACK, client_id: clientId, code_verifier: pkce().verifier });
    check('token: a wrong code_verifier is invalid_grant', badVerifier.status === 400 && badVerifier.body?.error === 'invalid_grant', badVerifier.body);
    const afterBad = await token({ grant_type: 'authorization_code', code: code1, redirect_uri: CALLBACK, client_id: clientId, code_verifier: p1.verifier });
    check('token: and the code is spent (single use, even after a wrong verifier)', afterBad.status === 400 && afterBad.body?.error === 'invalid_grant');

    const getTokens = async (login: typeof signedIn, client = clientId, extra: Record<string, string | undefined> = {}) => {
      as(login);
      const p = pkce();
      const answer = await authorize(ask(p, { client_id: client }));
      const code = new URL(answer.body.redirect).searchParams.get('code') ?? '';
      const tokens = await token({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client, code_verifier: p.verifier, resource: `${APP}/api/mcp`, ...extra });
      return { code, verifier: p.verifier, tokens };
    };
    const first = await getTokens(LOGINS.ana);
    const t1 = first.tokens.body ?? {};
    check('token: the right verifier gives an access and a refresh token for an hour, never cached', first.tokens.status === 200 && /^pmat_/.test(t1.access_token) && /^pmrt_/.test(t1.refresh_token)
      && t1.token_type === 'Bearer' && t1.expires_in === 3600 && t1.scope === 'connect' && first.tokens.headers.get('cache-control') === 'no-store', first.tokens.body);
    const wrongRedirect = await getTokens(LOGINS.ana, clientId, { redirect_uri: 'https://claude.ai/other' });
    check('token: redirect_uri must match the authorization request', wrongRedirect.tokens.status === 400 && wrongRedirect.tokens.body?.error === 'invalid_grant');
    const noRedirect = await getTokens(LOGINS.ana, clientId, { redirect_uri: undefined });
    check('token: redirect_uri may be left out (PKCE binds the code)', noRedirect.tokens.status === 200 && /^pmat_/.test(noRedirect.tokens.body?.access_token ?? ''), noRedirect.tokens.body);
    // Ended again, so the lists below count only the connections they make.
    await s.q("SELECT pm.oauth_revoke_grant(id, 'disconnected') FROM pm.oauth_grants WHERE member_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [s.ana]);
    as(LOGINS.ana);
    const pa = pkce();
    const forA = new URL((await authorize(ask(pa))).body.redirect).searchParams.get('code') ?? '';
    const byB = await token({ grant_type: 'authorization_code', code: forA, redirect_uri: CALLBACK, client_id: local.body.client_id, code_verifier: pa.verifier });
    check('token: another client cannot redeem this client\'s code', byB.status === 400 && byB.body?.error === 'invalid_grant', byB.body);
    const tokenRows = await s.q<Loose>('SELECT token_hash FROM pm.oauth_tokens');
    check('token: only hashes are stored', tokenRows.some((r: Loose) => r.token_hash === createHash('sha256').update(t1.access_token).digest('hex'))
      && !JSON.stringify(tokenRows).includes('pmat_'));

    // ── MCP as Ana ────────────────────────────────────────────────────
    const anaTools = await toolsOf({ bearer: t1.access_token });
    check('mcp: the bearer token lists Ana\'s connect tools', anaTools.answer.status === 200 && ['search_tasks', 'get_task', 'create_task', 'update_task', 'add_task_comment', 'list_reminders', 'add_reminder', 'ask_human', 'list_projects'].every((n) => anaTools.names.includes(n)), anaTools.names);
    check('mcp: and nothing outside the connect set (files, time, team, keys, agents)', !anaTools.names.some((n) => ['list_task_files', 'timer', 'list_team', 'create_api_key', 'create_agent', 'list_notifications', 'heartbeat', 'list_api_keys', 'set_agent_rules'].includes(n)), anaTools.names);
    const found = await callTool(t1.access_token, 'search_tasks', {});
    const titles = ((found?.data ?? []) as Loose[]).map((t) => t.title);
    check('mcp: a tool call runs as Ana, within her projects', found?.ok === true && titles.includes('Write the launch post') && !titles.includes('Hidden budget'), found);
    const made = await callTool(t1.access_token, 'create_task', { project_id: s.site, title: 'Made from Claude' });
    check('mcp: Ana\'s connection creates a task in her project', made?.ok === true && made.data?.title === 'Made from Claude', made);
    const outside = await callTool(t1.access_token, 'create_task', { project_id: s.secret, title: 'Not mine' });
    check('mcp: but not in a project she cannot open', outside?.ok === false && outside.status === 403, outside);
    await settle();
    const audit = await s.q<Loose>("SELECT * FROM pm.api_audit_log WHERE endpoint = '/api/v1/tasks' AND method = 'POST' AND team_member_id = $1", [s.ana]);
    const grantRow = (await s.q<Loose>('SELECT * FROM pm.oauth_grants WHERE member_id = $1 ORDER BY created_at LIMIT 1', [s.ana]))[0];
    check('audit: what the connection does is logged as Ana, via mcp_oauth, under its key', audit.length >= 1 && audit.every((r: Loose) => r.via === 'mcp_oauth' && r.api_key_id === grantRow.api_key_id), audit.map((r: Loose) => [r.via, r.api_key_id]));
    const createdTask = (await s.q<Loose>("SELECT created_via FROM pm.tasks WHERE title = 'Made from Claude'"))[0];
    check('audit: the task records it came through MCP', createdTask?.created_via === 'mcp', createdTask);
    const connected = await s.q<Loose>("SELECT * FROM pm.api_audit_log WHERE entity_type = 'oauth_grant' AND request_body->>'step' = 'connected' AND team_member_id = $1", [s.ana]);
    check('audit: connecting is logged (via mcp_oauth, the tool named)', connected.length >= 1 && connected[0].via === 'mcp_oauth' && connected[0].request_body.client_name === 'Claude');

    // The token works only where it is issued for.
    const restTry = await read(await v1Tasks.GET(new NextRequest(`${APP}/api/v1/tasks`, { headers: { 'x-api-key': t1.access_token } }), { params: Promise.resolve({}) } as never));
    const restBearer = await read(await v1Tasks.GET(new NextRequest(`${APP}/api/v1/tasks`, { headers: { authorization: `Bearer ${t1.access_token}` } }), { params: Promise.resolve({}) } as never));
    check('scope: other v1 routes refuse the token (401 connect_token_not_accepted), as header or bearer', restTry.status === 401 && restTry.body?.error?.details?.reason === 'connect_token_not_accepted'
      && restBearer.status === 401, [restTry.body, restBearer.status]);
    const withActFor = await mcp({ bearer: t1.access_token, actFor: 'pd_x' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    check('scope: a connection cannot act for someone else', withActFor.status === 403 && withActFor.body?.error?.data?.reason === 'act_for_not_allowed', withActFor.body);

    // ── An Owner's connection ─────────────────────────────────────────
    const ownerConn = await getTokens(LOGINS.owner);
    const ownerTools = await toolsOf({ bearer: ownerConn.tokens.body.access_token });
    const ownerKeyTools = await toolsOf({ key: s.keys.owner });
    check('mcp: an Owner\'s token has no admin tools (keys, team, agents, webhooks, access)', ownerTools.names.includes('create_task')
      && !ownerTools.names.some((n) => /api_key|agent|team|group|webhook|identity|assistant|setup/.test(n) && n !== 'list_project_agents' && n !== 'ask_human' && n !== 'list_my_projects'), ownerTools.names);
    check('mcp: while the Owner\'s own key with those scopes has them', ownerKeyTools.names.includes('create_api_key') && ownerKeyTools.names.includes('list_team'));

    // ── Tool catalog ──────────────────────────────────────────────────
    const catalog = async (headers: Record<string, string>) => read(await catalogRoute.GET(new NextRequest(`${APP}/api/v1/mcp/tools`, { headers }), { params: Promise.resolve({}) } as never));
    const anaCatalog = await catalog({ authorization: `Bearer ${t1.access_token}` });
    const anaNames = ((anaCatalog.body?.data?.tools ?? []) as Loose[]).map((t) => t.name);
    check('catalog: a token reads its own catalog, the same tools tools/list gives it', anaCatalog.status === 200 && JSON.stringify(anaNames) === JSON.stringify(anaTools.names), [anaCatalog.status, anaNames.length, anaTools.names.length]);
    const sample = (anaCatalog.body?.data?.tools ?? []).find((t: Loose) => t.name === 'create_task');
    check('catalog: each tool has its description, JSON input schema, annotations and routes; with a version and the MCP address',
      sample?.inputSchema?.type === 'object' && !!sample.inputSchema.properties?.title && typeof sample.description === 'string' && sample.annotations?.readOnlyHint === false
      && sample.routes?.[0]?.path === '/api/v1/tasks' && /^[0-9a-f]{16}$/.test(anaCatalog.body.data.version) && anaCatalog.body.data.mcp_url === `${APP}/api/mcp`, sample);
    const ownerCatalog = await catalog({ 'x-api-key': s.keys.owner });
    check('catalog: a key reads its own, and the version differs when the tools do', ownerCatalog.status === 200 && ownerCatalog.body.data.tools.some((t: Loose) => t.name === 'create_api_key')
      && ownerCatalog.body.data.version !== anaCatalog.body.data.version);
    check('catalog: the same caller gets the same version', (await catalog({ authorization: `Bearer ${t1.access_token}` })).body?.data?.version === anaCatalog.body.data.version);
    // An enterprise MCP server: its agent key with a delegation pass for Ana.
    const pass = (await s.q<Loose>('SELECT 1')).length ? `pd_${randomBytes(32).toString('hex')}` : '';
    await s.q("INSERT INTO pm.delegation_tokens (token_hash, agent_id, principal_id, minted_via, expires_at) VALUES ($1, $2, $3, 'session', now() + interval '15 minutes')",
      [createHash('sha256').update(pass).digest('hex'), s.jeff, s.ana]);
    const actingCatalog = await catalog({ 'x-api-key': s.keys.jeff, 'x-act-for': pass });
    const actingFound = await mcp({ key: s.keys.jeff, actFor: pass }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_tasks', arguments: {} } });
    check('catalog: with X-Act-For it is the agent\'s and the person\'s tools together, and the call runs for the person',
      actingCatalog.status === 200 && actingCatalog.body.data.tools.some((t: Loose) => t.name === 'search_tasks')
      && actingFound.body?.result?.structuredContent?.ok === true, [actingCatalog.status, actingCatalog.body?.error, actingFound.body?.result?.structuredContent?.error]);

    // ── Refresh rotation and reuse ───────────────────────────────────
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    check('refresh: a refresh token gives a new access and a new refresh token', r1.status === 200 && r1.body.access_token !== t1.access_token && r1.body.refresh_token !== t1.refresh_token, r1.body);
    check('refresh: the new access token works', (await toolsOf({ bearer: r1.body.access_token })).answer.status === 200);
    const otherClient = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: local.body.client_id });
    check('refresh: another client cannot use it', otherClient.status === 400 && otherClient.body?.error === 'invalid_grant');
    const reused = await token({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    check('refresh: using the old refresh token again is invalid_grant', reused.status === 400 && reused.body?.error === 'invalid_grant', reused.body);
    const afterReuse = await toolsOf({ bearer: r1.body.access_token });
    const nextRefresh = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId });
    check('refresh: and it revokes the whole family (new access and refresh tokens stop)', afterReuse.answer.status === 401 && nextRefresh.status === 400, [afterReuse.answer.status, nextRefresh.status]);
    const family = (await s.q<Loose>('SELECT g.revoked_reason, k.revoked_at FROM pm.oauth_grants g JOIN pm.api_keys k ON k.id = g.api_key_id WHERE g.id = $1', [grantRow.id]))[0];
    check('refresh: the grant says why, and its key is revoked', family.revoked_reason === 'refresh_reused' && !!family.revoked_at, family);

    // ── Code reuse ────────────────────────────────────────────────────
    const second = await getTokens(LOGINS.ana);
    check('code: a fresh sign-in works', second.tokens.status === 200);
    const replay = await token({ grant_type: 'authorization_code', code: second.code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: second.verifier });
    const afterReplay = await toolsOf({ bearer: second.tokens.body.access_token });
    check('code: a reused code is invalid_grant and revokes what it gave out', replay.status === 400 && replay.body?.error === 'invalid_grant' && afterReplay.answer.status === 401, [replay.body, afterReplay.answer.status]);

    // ── A secret client ───────────────────────────────────────────────
    const gw = secretReg.body;
    as(LOGINS.ana);
    const pg = pkce();
    const gwAuth = await authorize({ response_type: 'code', client_id: gw.client_id, redirect_uri: 'https://gateway.example.com/cb', code_challenge: pg.challenge, code_challenge_method: 'S256', state: 'g' });
    const gwCode = new URL(gwAuth.body.redirect).searchParams.get('code') ?? '';
    const noSecret = await token({ grant_type: 'authorization_code', code: gwCode, redirect_uri: 'https://gateway.example.com/cb', client_id: gw.client_id, code_verifier: pg.verifier });
    check('secret client: without its secret the token endpoint is 401 invalid_client', noSecret.status === 401 && noSecret.body?.error === 'invalid_client', noSecret.body);
    const basic = `Basic ${Buffer.from(`${gw.client_id}:${gw.client_secret}`).toString('base64')}`;
    const withSecret = await token({ grant_type: 'authorization_code', code: gwCode, redirect_uri: 'https://gateway.example.com/cb', code_verifier: pg.verifier }, { authorization: basic });
    check('secret client: with HTTP Basic it gets tokens (the code was not spent by the refused call)', withSecret.status === 200 && /^pmat_/.test(withSecret.body?.access_token ?? ''), withSecret.body);

    // ── Two return addresses: the list shows the one actually used ────
    const two = await register({ client_name: 'Two Doors', redirect_uris: ['https://first.example/cb', 'https://second.example/cb'], token_endpoint_auth_method: 'none' }, '198.51.100.3');
    as(LOGINS.ben);
    const pt = pkce();
    const viaSecond = await authorize({ response_type: 'code', client_id: two.body.client_id, redirect_uri: 'https://second.example/cb', code_challenge: pt.challenge, code_challenge_method: 'S256', state: 't' });
    const secondCode = new URL(viaSecond.body.redirect).searchParams.get('code') ?? '';
    const secondTokens = await token({ grant_type: 'authorization_code', code: secondCode, client_id: two.body.client_id, code_verifier: pt.verifier });
    const bensList = (await session(connectionsRoute.GET as never, 'GET', '/api/workspace/me/connections')).body?.data?.connections ?? [];
    check('account: a tool with two return addresses shows the one it signed in through', secondTokens.status === 200 && bensList.length === 1 && bensList[0].redirect_host === 'second.example', bensList);
    const storedRedirect = (await s.q<Loose>('SELECT redirect_uri FROM pm.oauth_grants WHERE member_id = $1', [s.ben]).catch(() => []))[0]?.redirect_uri;
    check('account: the connection keeps the address its code was issued with', storedRedirect === 'https://second.example/cb', storedRedirect);

    // ── Connected apps, Disconnect ────────────────────────────────────
    const third = await getTokens(LOGINS.ana);
    const list = await session(connectionsRoute.GET as never, 'GET', '/api/workspace/me/connections');
    const listed = (list.body?.data?.connections ?? []) as Loose[];
    check('account: Ana sees her live connected apps (name, dates, where it signs in from), never a token', list.status === 200 && list.body.data.mcp_url === `${APP}/api/mcp`
      && list.body.data.enabled === true && listed.length === 2 && listed.every((c) => ['Claude', 'Gateway'].includes(c.client_name) && c.connected_at)
      && listed.some((c) => c.redirect_host === 'claude.ai') && !/pm(at|rt|ac|cs)_/.test(list.text), list.body);
    const thirdGrant = (await s.q<Loose>('SELECT id FROM pm.oauth_grants WHERE member_id = $1 AND revoked_at IS NULL AND client_id = (SELECT id FROM pm.oauth_clients WHERE client_id = $2)', [s.ana, clientId]))[0].id;
    as(LOGINS.ben);
    const bensTry = await session(connectionRoute.DELETE as never, 'DELETE', `/api/workspace/me/connections/${thirdGrant}`, { id: thirdGrant });
    check('account: someone else cannot disconnect it', bensTry.status === 404);
    as(LOGINS.ana);
    const gone = await session(connectionRoute.DELETE as never, 'DELETE', `/api/workspace/me/connections/${thirdGrant}`, { id: thirdGrant });
    const afterDisconnect = await toolsOf({ bearer: third.tokens.body.access_token });
    const refreshAfter = await token({ grant_type: 'refresh_token', refresh_token: third.tokens.body.refresh_token, client_id: clientId });
    check('account: Disconnect stops its access and refresh tokens at once', gone.status === 200 && afterDisconnect.answer.status === 401 && refreshAfter.status === 400, [gone.status, afterDisconnect.answer.status, refreshAfter.status]);
    check('account: and it leaves the list', ((await session(connectionsRoute.GET as never, 'GET', '/api/workspace/me/connections')).body?.data?.connections ?? []).every((c: Loose) => c.id !== thirdGrant));
    check('audit: Disconnect is logged as Ana', (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_id = $1 AND request_body->>'step' = 'disconnected' AND team_member_id = $2", [thirdGrant, s.ana]))[0].n === 1);

    // ── A connection's key is not a key ──────────────────────────────
    const keyList = await read(await v1Keys.GET(new NextRequest(`${APP}/api/v1/api-keys?include_revoked=true&limit=100`, { headers: { 'x-api-key': s.keys.owner } }), { params: Promise.resolve({}) } as never));
    check('keys: connections are never listed as API keys', keyList.status === 200 && keyList.body.data.length > 0 && keyList.body.data.every((k: Loose) => k.permissions !== 'connection'), keyList.body?.data?.map((k: Loose) => k.permissions));
    const ownerGrantKey = (await s.q<Loose>('SELECT api_key_id FROM pm.oauth_grants WHERE member_id = $1 AND revoked_at IS NULL', [s.owner]))[0].api_key_id;
    as(LOGINS.owner);
    const editTry = await session(keyEditRoute.PATCH as never, 'PATCH', `/api/workspace/api-keys/${ownerGrantKey}`, { id: ownerGrantKey }, { name: 'Mine now', scopes: ['api_keys.manage_all'] });
    const rotateTry = await session(keyRotateRoute.POST as never, 'POST', `/api/workspace/api-keys/${ownerGrantKey}/rotate`, { id: ownerGrantKey }, { overlap_hours: 0 });
    const revokeTry = await session(keyRevokeRoute.POST as never, 'POST', `/api/workspace/api-keys/${ownerGrantKey}/revoke`, { id: ownerGrantKey });
    check('keys: a connection\'s key cannot be edited, rotated or revoked as a key (404)', editTry.status === 404 && rotateTry.status === 404 && revokeTry.status === 404, [editTry.status, rotateTry.status, revokeTry.status]);
    check('keys: and the Owner\'s connection still works', (await toolsOf({ bearer: ownerConn.tokens.body.access_token })).answer.status === 200);

    // ── The workspace switch ──────────────────────────────────────────
    const live = await getTokens(LOGINS.ana);
    as(LOGINS.admin);
    const adminFlip = await session(switchRoute.PUT as never, 'PUT', '/api/workspace/connect-ai', {}, { enabled: false });
    check('switch: an admin cannot turn it off', adminFlip.status === 403 && adminFlip.body?.error?.details?.reason === 'owner_only', adminFlip.body);
    as(LOGINS.owner);
    const off = await session(switchRoute.PUT as never, 'PUT', '/api/workspace/connect-ai', {}, { enabled: false });
    check('switch: an Owner turns it off', off.status === 200 && off.body?.data?.enabled === false, off.body);
    const offMcp = await mcp({ bearer: live.tokens.body.access_token }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    check('switch: off, a connected tool gets 403 connect_ai_off', offMcp.status === 403 && offMcp.body?.error?.data?.reason === 'connect_ai_off', offMcp.body);
    const offRegister = await register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }, '198.51.100.9');
    const offRefresh = await token({ grant_type: 'refresh_token', refresh_token: live.tokens.body.refresh_token, client_id: clientId });
    as(LOGINS.ana);
    const offAuthorize = await authorize(ask(pkce()));
    check('switch: off, registration and the token endpoint are 403 access_denied, and Allow sends back access_denied',
      offRegister.status === 403 && offRegister.body?.error === 'access_denied' && offRefresh.status === 403
      && new URL(offAuthorize.body?.redirect ?? 'x:/').searchParams.get('error') === 'access_denied', [offRegister.body, offRefresh.status, offAuthorize.body]);
    check('switch: off, the account page says so', (await session(connectionsRoute.GET as never, 'GET', '/api/workspace/me/connections')).body?.data?.enabled === false);
    as(LOGINS.owner);
    await session(switchRoute.PUT as never, 'PUT', '/api/workspace/connect-ai', {}, { enabled: true });
    check('switch: back on, the same connection works again', (await toolsOf({ bearer: live.tokens.body.access_token })).answer.status === 200);
    await settle();
    check('switch: flipping it is audited as the Owner', (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_type = 'business_settings' AND team_member_id = $1 AND request_body->'changed' ? 'connect_ai_enabled'", [s.owner]))[0].n >= 2);

    // ── Suspension ────────────────────────────────────────────────────
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.ana]);
    const suspended = await toolsOf({ bearer: live.tokens.body.access_token });
    const anaGrants = await s.q<Loose>('SELECT g.revoked_at, g.revoked_reason, k.revoked_at AS key_revoked FROM pm.oauth_grants g JOIN pm.api_keys k ON k.id = g.api_key_id WHERE g.member_id = $1', [s.ana]);
    check('suspend: suspending Ana revokes every connection of hers and its key', suspended.answer.status === 401 && anaGrants.every((g: Loose) => g.revoked_at && g.key_revoked)
      && anaGrants.some((g: Loose) => g.revoked_reason === 'member_suspended'), [suspended.answer.status, anaGrants]);
    check('suspend: the cascade records it', (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint = $1 AND request_body->>'step' = 'connections_revoked'", [`/app/team-members/${s.ana}/deprovision`]))[0].n === 1);
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.ana]);
    check('suspend: reactivated, revoked connections stay revoked', (await toolsOf({ bearer: live.tokens.body.access_token })).answer.status === 401);
    check('suspend: the Owner\'s connection is untouched', (await toolsOf({ bearer: ownerConn.tokens.body.access_token })).answer.status === 200);

    // ── The sweep ─────────────────────────────────────────────────────
    const oldUnused = await register({ client_name: 'Abandoned', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }, '198.51.100.4');
    const freshUnused = await register({ client_name: 'Just registered', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }, '198.51.100.5');
    await s.q("UPDATE pm.oauth_clients SET created_at = now() - interval '2 days' WHERE client_id IN ($1, $2)", [oldUnused.body.client_id, clientId]);
    await s.q("INSERT INTO pm.oauth_rate_limit_windows (bucket, window_start, request_count) VALUES ('register:old', now() - interval '2 hours', 3), ('register:live', now(), 1)");
    const windowsBefore = (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.oauth_rate_limit_windows'))[0].n;
    await actAs(db, null);
    const swept = (await db.query<Loose>('SELECT pm.oauth_sweep() AS r').then((r) => r.rows, () => [{ r: {} }]))[0].r;
    await db.exec('RESET ROLE');
    const left = (await s.q<Loose>('SELECT client_id FROM pm.oauth_clients')).map((r: Loose) => r.client_id);
    check('sweep: a tool nobody connected for a day goes; a new one and one with connections stay', !left.includes(oldUnused.body.client_id)
      && left.includes(freshUnused.body.client_id) && left.includes(clientId) && swept.clients >= 1, { swept, left: left.length });
    const windows = (await s.q<Loose>('SELECT bucket FROM pm.oauth_rate_limit_windows')).map((r: Loose) => r.bucket);
    check('sweep: rate windows past the longest window go, live ones stay', !windows.includes('register:old') && windows.includes('register:live') && windows.length < windowsBefore, windows);
    check('sweep: spent codes over an hour old go', (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.oauth_codes WHERE expires_at < now() - interval '1 hour'"))[0].n === 0);

    // ── No tokens anywhere in the audit log ──────────────────────────
    await settle();
    const allAudit = JSON.stringify(await s.q<Loose>('SELECT * FROM pm.api_audit_log'));
    check('audit: no access token, refresh token, code or client secret is ever logged', !/pm(at|rt|ac|cs)_[0-9a-f]{8}/.test(allAudit) && allAudit.includes('mcp_oauth'));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`connect ai: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`connect ai: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
