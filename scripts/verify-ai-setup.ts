/**
 * Set up agents with AI (20261127000500_ai_setup.sql, lib/ai-setup.ts): an
 * Owner lets their own AI tool set up agents for one hour, end to end over
 * the real routes (the session routes as a signed-in person, the OAuth
 * routes, the MCP route, v1 routes) on a fake PostgREST over PGlite with the
 * full schema:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   browsers hold nothing on the new table; its rules hold.
 * - A connected tool without a session is still refused every setup tool.
 * - Only someone who may hire (an Owner) starts a session; a session row
 *   for anyone else gives nothing.
 * - A session gives the connection the setup tools only, on the setup
 *   routes only; a key or webhook it makes is an agent's, never a person's.
 * - It never exceeds the person's live powers (a module switched off
 *   mid-session takes its scopes away).
 * - The audit log records each change as made by the tool (its key) for the
 *   person (principal_id); starting and ending are recorded too.
 * - It expires on its own, and ending it stops it at once; agents and their
 *   keys stay.
 * - A setup key carries the setup scopes only, works on the setup routes
 *   only, and stops when ended.
 *
 *   npm run -s test:ai-setup
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  AI_SETUP_EXAMPLES, AI_SETUP_KEY_SCOPES, AI_SETUP_ROUTES, AI_SETUP_TOOLS, aiSetupKeyScopes, aiSetupPrompt, aiSetupRoute, mayStartAiSetup, minutesLeft,
} from '../src/lib/ai-setup';
import { PM_TOOLS } from '../src/lib/mcp/tools';
import { AGENT_HIRE_ENDPOINT } from '../src/lib/api/agent-context';
import type { AccessContext } from '../src/lib/access-control';

const MIGRATION = '20261127000500_ai_setup.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- AI SETUP (20261127000500_ai_setup.sql)';
const APP = 'https://pm.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const UUID = '00000000-0000-4000-8000-0000000000aa';

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
  owner: { id: '00000000-0000-4000-8000-00000000a001', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000a002', email: 'ana@example.com' },
  admin: { id: '00000000-0000-4000-8000-00000000a004', email: 'ada@example.com' },
};
let signedIn = LOGINS.owner;

/** Supabase Auth, as far as these routes use it: who is signed in, and a login made for a new agent. */
function authStandIn(db: () => PGlite) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
      return true;
    };
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' });
    }
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const text = await new Promise<string>((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw));
      });
      const body = JSON.parse(text || '{}');
      const id = randomUUID();
      await db().exec('RESET ROLE');
      await db().query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, String(body.email).toLowerCase()]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email: body.email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' });
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

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  const concrete = (path: string) => path.replace(/\{\w+\}/g, UUID);
  for (const [method, path] of AI_SETUP_ROUTES) {
    check(`routes: ${method} ${path} is a setup route`, aiSetupRoute(method, concrete(path)) === path, aiSetupRoute(method, concrete(path)));
  }
  for (const [method, path] of [
    ['GET', '/api/v1/tasks'], ['POST', '/api/v1/tasks'], ['PATCH', `/api/v1/team-members/${UUID}`], ['GET', '/api/v1/api-keys'],
    ['POST', `/api/v1/api-keys/${UUID}/revoke`], ['POST', `/api/v1/api-keys/${UUID}/rotate`], ['PATCH', `/api/v1/webhook-endpoints/${UUID}`],
    ['DELETE', `/api/v1/webhook-endpoints/${UUID}`], ['POST', '/api/v1/groups'], ['PATCH', '/api/v1/agents/me'], ['POST', '/api/v1/agents/import'],
    ['GET', '/api/v1/agents/me/status'], ['GET', '/api/v1/audit-log'], ['POST', '/api/v1/agent-templates'], ['POST', '/api/v1/assistants/provision'],
  ] as const) {
    check(`routes: ${method} ${path} is not`, aiSetupRoute(method, path) === null);
  }
  // Every route of every setup tool is a setup route, and every setup tool exists.
  for (const name of AI_SETUP_TOOLS) {
    const tool = PM_TOOLS.find((t) => t.name === name);
    check(`tools: ${name} exists`, !!tool);
    for (const route of tool?.routes ?? []) {
      check(`tools: ${name} calls only setup routes (${route.method} ${route.path})`, aiSetupRoute(route.method, concrete(route.path)) !== null);
    }
  }
  check('tools: no admin tool beyond agent setup is in the set', !AI_SETUP_TOOLS.some((n) => ['list_api_keys', 'revoke_api_key', 'rotate_api_key', 'set_agent_rules', 'create_group', 'update_webhook_endpoint',
    'delete_webhook_endpoint', 'setup_project', 'create_agent_template', 'import_agent_config', 'provision_assistants'].includes(n)));

  const owner: AccessContext = { member_id: 'o', role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
  const admin: AccessContext = { member_id: 'a', role: 'admin', status: 'active', app_permissions: ['*'], api_permissions: ['team.manage', 'team.read', 'api_keys.manage_all'], project_ids: [] };
  const member: AccessContext = { member_id: 'm', role: 'member', status: 'active', app_permissions: [], api_permissions: ['tasks.read', 'projects.read'], project_ids: [] };
  check('who: an Owner may start; an admin with team.manage, a member and a suspended Owner may not',
    mayStartAiSetup(owner) && !mayStartAiSetup(admin) && !mayStartAiSetup(member) && !mayStartAiSetup({ ...owner, status: 'suspended' }));
  check('setup key: an Owner\'s carries exactly the setup scopes', JSON.stringify(aiSetupKeyScopes(owner)) === JSON.stringify(AI_SETUP_KEY_SCOPES));
  check('setup key: the setup scopes hold no task, time, settings, access or act-for power',
    !AI_SETUP_KEY_SCOPES.some((s) => /^(tasks|time|settings|access|audit|contacts|leads|invoices|files|credentials)\.|act_for|context\.memory|approvals/.test(s)), AI_SETUP_KEY_SCOPES);
  check('setup key: a member\'s carries only what they hold of it', JSON.stringify(aiSetupKeyScopes(member)) === JSON.stringify(['projects.read']));
  const prompt = aiSetupPrompt(AI_SETUP_EXAMPLES[0].request);
  check('prompt: the company example is the owner\'s own words, and every prompt says to read pm_guide first, ask first, read it back',
    /Alexa who runs the company, hands work to Jeff, John and Greg, and can act for me/.test(prompt) && /Start with pm_guide/.test(prompt)
    && /Ask me anything you need before/.test(prompt) && /get_agent_setup/.test(prompt));
  check('prompt: examples per role (company, inbox triage, builder, reviewer, external)', ['company', 'inbox-triage', 'builder', 'reviewer', 'external'].every((id) => AI_SETUP_EXAMPLES.some((e) => e.id === id)));
  check('copy: no em dashes', !/—/.test(JSON.stringify({ AI_SETUP_EXAMPLES, prompt })));
  check('time: minutes left reads 60 at the start and never goes below 0', minutesLeft(new Date(Date.now() + 3_600_000).toISOString()) === 60 && minutesLeft(new Date(Date.now() - 5000).toISOString()) === 0);
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the AI setup section is there and mirrors the migration', at > 0 && banner > 0 && SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.trim()));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  await old.exec('RESET ROLE');
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.exec('RESET ROLE');
  const grants = (await fresh.query<Loose>(`SELECT bool_or(has_table_privilege(r, 'pm.ai_setup_sessions', p)) AS any_access
    FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`)).rows[0];
  check('grants: browsers cannot read or write sessions', grants.any_access === false, grants);
  const person = (await fresh.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'owner') RETURNING id")).rows[0].id;
  const fail = (sql: string, params: unknown[] = []) => fresh.query(sql, params).then(() => null, (e: Error) => e.message);
  check('rules: a connection session needs its connection', /target_check/.test(await fail("INSERT INTO pm.ai_setup_sessions (member_id, kind, client_name, expires_at) VALUES ($1, 'connection', 'Claude', now() + interval '1 hour')", [person]) ?? ''));
  check('rules: an unknown kind is refused', /kind_check/.test(await fail("INSERT INTO pm.ai_setup_sessions (member_id, kind, client_name, expires_at) VALUES ($1, 'forever', 'x', now() + interval '1 hour')", [person]) ?? ''));
  check('rules: no session lasts over two hours', /length_check/.test(await fail("INSERT INTO pm.ai_setup_sessions (member_id, kind, client_name, expires_at) VALUES ($1, 'key', 'k', now() + interval '3 hours')", [person]) ?? ''));
  check('rules: a key session for an hour is fine', (await fail("INSERT INTO pm.ai_setup_sessions (member_id, kind, client_name, expires_at) VALUES ($1, 'key', 'k', now() + interval '1 hour')", [person])) === null);
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
  const admin = await member('Ada', 'admin', LOGINS.admin);
  const jeff = await member('Jeff', 'agent');
  // Ada manages the team on both channels, and still may not hire.
  for (const channel of ['app', 'api']) {
    for (const permission of ['team.manage', 'api_keys.manage_all']) {
      await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, $3, 'allow') ON CONFLICT DO NOTHING", [admin, permission, channel]);
    }
  }
  const site = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Site') RETURNING id"))[0].id;
  for (const m of [owner, ana, jeff]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [site, m]);
  return { q, owner, ana, admin, jeff, site };
}

async function main() {
  pureChecks();
  check('hire audit: the page finds a hire where hireAgent records it', AGENT_HIRE_ENDPOINT === '/api/workspace/agents');
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(() => db) });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: APP,
  });
  installSession(server.url);
  try {
    const { AI_SETUP_AGENT_ENDPOINTS } = await import('../src/lib/api/ai-setup');
    check('hire audit: the endpoints the page reads are the ones hires write', AI_SETUP_AGENT_ENDPOINTS.includes(AGENT_HIRE_ENDPOINT) && AI_SETUP_AGENT_ENDPOINTS.includes('/api/v1/agents'));
    const registerRoute = await import('../src/app/api/oauth/register/route');
    const tokenRoute = await import('../src/app/api/oauth/token/route');
    const authorizeRoute = await import('../src/app/api/oauth/authorize/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const setupRoute = await import('../src/app/api/workspace/ai-setup/route');
    const endRoute = await import('../src/app/api/workspace/ai-setup/[id]/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Team = await import('../src/app/api/v1/team-members/route');
    const v1Member = await import('../src/app/api/v1/team-members/[id]/route');
    const v1Hire = await import('../src/app/api/v1/agents/hire/route');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    let ip = 1;
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'content-type': 'application/json', origin: APP }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const mcp = async (credential: { bearer?: string; key?: string }, body: unknown) => read(await mcpRoute.POST(new NextRequest(`${APP}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
        ...(credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}),
        ...(credential.key ? { 'x-api-key': credential.key } : {}),
      },
      body: JSON.stringify(body),
    })));
    const toolsOf = async (credential: { bearer?: string; key?: string }) => {
      const answer = await mcp(credential, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      return ((answer.body?.result?.tools ?? []) as Loose[]).map((t) => t.name as string);
    };
    const callTool = (credential: { bearer?: string; key?: string }, name: string, args: Record<string, unknown>) =>
      mcp(credential, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }).then((a) => a.body?.result?.structuredContent as Loose);
    const rest = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, key: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-api-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));

    // A connected Claude for a person, through the real OAuth routes.
    const reg = await read(await registerRoute.POST(new NextRequest(`${APP}/api/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    })));
    const clientId: string = reg.body?.client_id;
    const connect = async (login: typeof signedIn) => {
      as(login);
      const p = pkce();
      const allowed = await session(authorizeRoute.POST as never, 'POST', '/api/oauth/authorize', {}, {
        response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: p.challenge, code_challenge_method: 'S256', state: 's', resource: `${APP}/api/mcp`, decision: 'allow',
      });
      const code = new URL(allowed.body.redirect).searchParams.get('code') ?? '';
      const tokens = await read(await tokenRoute.POST(new NextRequest(`${APP}/api/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${ip++}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: p.verifier }).toString(),
      })));
      const grant = (await s.q<Loose>('SELECT id, api_key_id FROM pm.oauth_grants WHERE member_id = (SELECT id FROM pm.team_members WHERE auth_user_id = $1) AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [login.id]))[0];
      return { token: tokens.body?.access_token as string, grantId: grant?.id as string, keyId: grant?.api_key_id as string };
    };
    const owner = await connect(LOGINS.owner);
    const adminConn = await connect(LOGINS.admin);
    check('setup: the Owner and the admin each have a connected Claude', /^pmat_/.test(owner.token ?? '') && !!owner.grantId && /^pmat_/.test(adminConn.token ?? ''), [owner, adminConn]);
    const claude = { bearer: owner.token };

    // ── Without a session, a connected tool is still refused ─────────
    const before = await toolsOf(claude);
    check('no session: an Owner\'s connected tool sees no setup tool', before.includes('create_task') && !before.some((n) => ['hire_agent', 'create_agent', 'create_api_key', 'list_agent_templates', 'create_webhook_endpoint', 'update_agent'].includes(n)), before);
    const refused = await callTool(claude, 'hire_agent', { name: 'Sneaky' });
    check('no session: calling hire_agent by name is refused', refused?.ok === false && refused.status === 404, refused);
    check('no session: no agent was made', (await s.q<Loose>("SELECT id FROM pm.team_members WHERE name = 'Sneaky'")).length === 0);

    // ── Only someone who may hire starts one ─────────────────────────
    as(LOGINS.admin);
    const adminStart = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'connection', grant_id: adminConn.grantId });
    const adminKey = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'key' });
    as(LOGINS.ana);
    const anaKey = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'key' });
    check('who: an admin who manages the team, and a member, are refused (403 owner_only)', adminStart.status === 403 && adminKey.status === 403 && anaKey.status === 403
      && adminStart.body?.error?.details?.reason === 'owner_only', [adminStart.body, adminKey.status, anaKey.status]);
    check('who: and nothing was made for them', (await s.q<Loose>('SELECT id FROM pm.ai_setup_sessions')).length === 0
      && (await s.q<Loose>("SELECT id FROM pm.api_keys WHERE key_prefix LIKE 'pk_setup_%'")).length === 0);
    // A session row for the admin, written behind the app's back, still gives nothing.
    await s.q("INSERT INTO pm.ai_setup_sessions (member_id, kind, grant_id, api_key_id, client_name, scopes, expires_at) VALUES ($1, 'connection', $2, $3, 'Claude', $4, now() + interval '1 hour')",
      [s.admin, adminConn.grantId, adminConn.keyId, ['team.manage', 'team.read', 'api_keys.manage_all']]);
    const adminTools = await toolsOf({ bearer: adminConn.token });
    const adminTry = await callTool({ bearer: adminConn.token }, 'create_agent', { name: 'Shadow', email: 'shadow@agents.invalid' });
    check('who: a session row for a non-Owner gives no setup tool and no call', !adminTools.includes('create_agent') && !adminTools.includes('hire_agent') && adminTry?.ok === false, [adminTools.filter((n) => /agent|key/.test(n)), adminTry]);

    // ── An Owner lets Claude set up agents ───────────────────────────
    as(LOGINS.owner);
    const started = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'connection', grant_id: owner.grantId });
    const live = started.body?.data?.session;
    const length = live ? new Date(live.expires_at).getTime() - new Date(live.created_at).getTime() : 0;
    check('start: the Owner starts a one-hour session for their connected Claude', started.status === 201 && live?.active === true && live.client_name === 'Claude'
      && Math.abs(length - 3_600_000) < 5000, started.body);
    const startedAudit = await s.q<Loose>("SELECT * FROM pm.api_audit_log WHERE entity_type = 'ai_setup_session' AND request_body->>'step' = 'started'");
    check('audit: starting is recorded, by the Owner, naming the tool and when it ends', startedAudit.length === 1 && startedAudit[0].team_member_id === s.owner
      && startedAudit[0].request_body.tool === 'Claude' && !!startedAudit[0].request_body.expires_at && startedAudit[0].via === 'app', startedAudit);
    const otherGrant = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'connection', grant_id: adminConn.grantId });
    check('start: never for someone else\'s connection', otherGrant.status === 404, otherGrant.body);

    const during = await toolsOf(claude);
    check('session: the setup tools appear, and the connection keeps its own tools', ['hire_agent', 'create_agent', 'create_api_key', 'list_agent_templates', 'create_webhook_endpoint', 'set_project_agent', 'list_team'].every((n) => during.includes(n))
      && during.includes('create_task'), during);
    check('session: but no other admin tool', !during.some((n) => ['list_api_keys', 'revoke_api_key', 'rotate_api_key', 'set_agent_rules', 'create_group', 'update_webhook_endpoint', 'delete_webhook_endpoint',
      'setup_project', 'create_agent_template', 'list_notifications', 'timer', 'list_agent_activity'].includes(n)), during.filter((n) => !before.includes(n)));
    const guide = await callTool(claude, 'pm_guide', {});
    check('session: pm_guide explains the session and lists the templates', /Setting up agents with AI/.test(guide?.guide ?? '') && /Olivia let you set up agents/.test(guide?.guide ?? '')
      && Array.isArray(guide?.agent_templates) && guide.agent_templates.some((t: Loose) => t.key === 'builder'), [String(guide?.guide ?? '').slice(-400), guide?.agent_templates?.length]);
    const blocked = await callTool(claude, 'list_api_keys', {});
    check('session: a tool outside agent setup is still refused by name', blocked?.ok === false && blocked.status === 404, blocked);

    const hired = await callTool(claude, 'hire_agent', {
      name: 'Alexa', agent_role: 'orchestrator', description: 'Runs the company and hands work to Jeff.', project_ids: [s.site],
      create_key: true, scopes: ['tasks.read', 'projects.read', 'agents.act_for'],
    });
    const alexa = hired?.data?.agent?.id as string | undefined;
    check('hire: Claude hires Alexa through the same rules as the screen (project, key with act-for given beyond the role)', hired?.ok === true && !!alexa
      && hired.data.assignments?.length === 1 && /^pk_live_/.test(hired.data.key?.secret ?? '') && hired.data.scopes_beyond_role?.includes('agents.act_for'), hired);
    await settle();
    const hireAudit = (await s.q<Loose>("SELECT * FROM pm.api_audit_log WHERE endpoint = $1 AND entity_id = $2", [AGENT_HIRE_ENDPOINT, alexa]))[0];
    check('audit: the hire is recorded as made by Claude (its key, via mcp_oauth) for Olivia', hireAudit?.api_key_id === owner.keyId && hireAudit.team_member_id === s.owner
      && hireAudit.principal_id === s.owner && hireAudit.via === 'mcp_oauth', hireAudit);
    const keyRow = (await s.q<Loose>('SELECT scopes, created_by_key_id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [alexa]))[0];
    check('hire: the agent\'s key carries exactly what was asked', JSON.stringify([...(keyRow?.scopes ?? [])].sort()) === JSON.stringify(['agents.act_for', 'projects.read', 'tasks.read']), keyRow);

    // Agents only: never the person, never another person.
    const selfKey = await callTool(claude, 'create_api_key', { agent_id: s.owner, name: 'Mine now', scopes: ['tasks.read'] });
    const anaKeyTry = await callTool(claude, 'create_api_key', { agent_id: s.ana, name: 'Ana', scopes: ['tasks.read'] });
    check('agents only: a key for the Owner themself, or for a person, is refused (403 ai_setup_agents_only)', selfKey?.ok === false && selfKey.error?.reason === 'ai_setup_agents_only'
      && anaKeyTry?.ok === false && anaKeyTry.error?.reason === 'ai_setup_agents_only', [selfKey, anaKeyTry]);
    const agentKey = await callTool(claude, 'create_api_key', { agent_id: alexa, name: 'Alexa second key', scopes: ['tasks.read'] });
    check('agents only: a key for the agent it hired is fine', agentKey?.ok === true && /^pk_live_/.test(agentKey.data?.secret ?? ''), agentKey);
    const wideHook = await callTool(claude, 'create_webhook_endpoint', { name: 'Everything', url: 'https://hooks.example.com/all', events: ['task.created'] });
    const agentHook = await callTool(claude, 'create_webhook_endpoint', { name: 'Alexa wake', url: 'https://hooks.example.com/alexa', events: ['task.created'], member_id: alexa });
    check('agents only: a workspace-wide webhook is refused; one for the agent is made', wideHook?.ok === false && agentHook?.ok === true, [wideHook, agentHook?.error ?? agentHook?.ok]);
    const touchAna = await callTool(claude, 'update_agent', { agent_id: s.ana, name: 'Not an agent' });
    check('agents only: changing a person through update_agent is refused', touchAna?.ok === false && (await s.q<Loose>('SELECT name FROM pm.team_members WHERE id = $1', [s.ana]))[0].name === 'Ana', touchAna);

    // Never more than the person: a module switched off takes its scopes away mid-session.
    const tim = await callTool(claude, 'hire_agent', { name: 'Tim', create_key: true, scopes: ['tasks.read', 'time.manage_own'] });
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'time'");
    const tom = await callTool(claude, 'hire_agent', { name: 'Tom', create_key: true, scopes: ['tasks.read', 'time.manage_own'] });
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'time'");
    check('powers: with time tracking on, a key with a time power is fine; switched off mid-session, the same hire is refused',
      tim?.ok === true && tom?.ok === false && (await s.q<Loose>("SELECT id FROM pm.team_members WHERE name = 'Tom' AND status = 'active'")).length === 0, [tim?.ok, tom]);

    // The page watches: each agent it made, with role, powers and projects.
    const view = await session(setupRoute.GET as never, 'GET', '/api/workspace/ai-setup');
    const liveView = view.body?.data?.sessions?.find((x: Loose) => x.active);
    const listed = liveView?.agents?.find((a: Loose) => a.id === alexa);
    check('page: the live session lists Alexa with her role, powers and project', view.status === 200 && !!listed && listed.agent_role === 'orchestrator' && listed.powers === 3
      && listed.projects?.[0]?.name === 'Site' && liveView.agents.some((a: Loose) => a.name === 'Tim'), liveView);
    check('page: the Owner\'s connected tools are offered', view.body?.data?.connections?.some((c: Loose) => c.id === owner.grantId) && view.body.data.may_start === true);

    // ── It ends on its own ───────────────────────────────────────────
    await s.q("UPDATE pm.ai_setup_sessions SET created_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute' WHERE grant_id = $1", [owner.grantId]);
    const expired = await toolsOf(claude);
    const afterExpiry = await callTool(claude, 'hire_agent', { name: 'Late' });
    check('expiry: after its hour the setup tools are gone and calls are refused', !expired.includes('hire_agent') && expired.includes('create_task') && afterExpiry?.ok === false, expired.filter((n) => /agent/.test(n)));
    check('expiry: the agents and keys it made stay', (await s.q<Loose>('SELECT id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [alexa])).length === 2);

    // ── Ending it early ──────────────────────────────────────────────
    const again = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'connection', grant_id: owner.grantId });
    check('end: a new session works again', again.status === 201 && (await toolsOf(claude)).includes('hire_agent'));
    as(LOGINS.ana);
    const anaEnds = await session(endRoute.DELETE as never, 'DELETE', `/api/workspace/ai-setup/${again.body.data.session.id}`, { id: again.body.data.session.id });
    as(LOGINS.owner);
    check('end: nobody else ends it', anaEnds.status === 404 && (await toolsOf(claude)).includes('hire_agent'));
    const ended = await session(endRoute.DELETE as never, 'DELETE', `/api/workspace/ai-setup/${again.body.data.session.id}`, { id: again.body.data.session.id });
    const afterEnd = await toolsOf(claude);
    const afterEndCall = await callTool(claude, 'create_agent', { name: 'After', email: 'after@agents.invalid' });
    check('end: ending it stops the setup tools at once', ended.status === 200 && !afterEnd.includes('hire_agent') && afterEndCall?.ok === false, [ended.body, afterEndCall]);
    check('end: ending is recorded, by the Owner', (await s.q<Loose>("SELECT team_member_id FROM pm.api_audit_log WHERE entity_type = 'ai_setup_session' AND request_body->>'step' = 'ended' AND entity_id = $1", [again.body.data.session.id]))
      .map((r: Loose) => r.team_member_id).join() === s.owner);

    // ── A setup key ──────────────────────────────────────────────────
    const made = await session(setupRoute.POST as never, 'POST', '/api/workspace/ai-setup', {}, { kind: 'key' });
    const setupKey: string = made.body?.data?.secret ?? '';
    const setupRow = (await s.q<Loose>("SELECT * FROM pm.api_keys WHERE name = 'AI setup key' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"))[0];
    check('key: a setup key, shown once, lasting an hour, of the Owner\'s own', made.status === 201 && /^pk_setup_[0-9a-f]{48}$/.test(setupKey) && setupRow?.team_member_id === s.owner
      && Math.abs(new Date(setupRow.expires_at).getTime() - Date.now() - 3_600_000) < 10_000 && made.body.data.connect?.mcp_url === `${APP}/api/mcp`, made.body);
    check('key: it carries only the setup scopes', JSON.stringify([...(setupRow?.scopes ?? [])].sort()) === JSON.stringify([...AI_SETUP_KEY_SCOPES].sort()), setupRow?.scopes);
    check('key: only its hash is stored', setupRow?.key_hash === createHash('sha256').update(setupKey).digest('hex') && !JSON.stringify(await s.q('SELECT * FROM pm.ai_setup_sessions')).includes(setupKey));
    const keyTools = await toolsOf({ key: setupKey });
    check('key: over MCP it sees the setup tools and nothing else', keyTools.includes('hire_agent') && keyTools.includes('list_projects') && keyTools.every((n) => AI_SETUP_TOOLS.includes(n))
      && !keyTools.includes('create_task') && !keyTools.includes('search_tasks'), keyTools);
    const keyTasks = await rest(v1Tasks.GET as never, 'GET', '/api/v1/tasks', setupKey);
    const keyTeam = await rest(v1Team.GET as never, 'GET', '/api/v1/team-members', setupKey);
    const keyPerson = await rest(v1Member.PATCH as never, 'PATCH', `/api/v1/team-members/${s.ana}`, setupKey, { id: s.ana }, { title: 'Changed' });
    check('key: over REST, routes outside agent setup are refused (403 ai_setup_only), even ones its scopes cover', keyTasks.status === 403 && keyTasks.body?.error?.details?.reason === 'ai_setup_only'
      && keyPerson.status === 403 && keyPerson.body?.error?.details?.reason === 'ai_setup_only' && keyTeam.status === 200, [keyTasks.status, keyPerson.body, keyTeam.status]);
    const viaKey = await callTool({ key: setupKey }, 'hire_agent', { name: 'Nova', project_ids: [s.site], create_key: true, scopes: ['tasks.read', 'tasks.create', 'projects.read'] });
    check('key: it hires an agent whose key carries the Owner\'s powers, though the setup key itself does not', viaKey?.ok === true
      && JSON.stringify([...(viaKey.data?.key?.scopes ?? [])].sort()) === JSON.stringify(['projects.read', 'tasks.create', 'tasks.read']), viaKey);
    await settle();
    const keyAudit = (await s.q<Loose>('SELECT * FROM pm.api_audit_log WHERE endpoint = $1 AND entity_id = $2', [AGENT_HIRE_ENDPOINT, viaKey?.data?.agent?.id]))[0];
    check('key: its hire is recorded as made by the setup key for the Owner', keyAudit?.api_key_id === setupRow.id && keyAudit.principal_id === s.owner && keyAudit.via === 'mcp', keyAudit);
    const restHire = await rest(v1Hire.POST as never, 'POST', '/api/v1/agents/hire', setupKey, {}, { name: 'Rex', create_key: true, scopes: ['tasks.read'] });
    check('key: hire works over REST too', restHire.status === 201 && restHire.body?.data?.agent?.name === 'Rex', restHire.body);
    const keyView = await session(setupRoute.GET as never, 'GET', '/api/workspace/ai-setup');
    const keySession = keyView.body?.data?.sessions?.find((x: Loose) => x.kind === 'key' && x.active);
    check('key: the page lists what the setup key made', keySession?.agents?.some((a: Loose) => a.name === 'Nova') && keySession.agents.some((a: Loose) => a.name === 'Rex'), keySession);
    await session(endRoute.DELETE as never, 'DELETE', `/api/workspace/ai-setup/${keySession?.id}`, { id: keySession?.id });
    const stopped = await mcp({ key: setupKey }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    check('key: ended, the setup key stops at once (401) and is disabled, not revoked, so the keys it made stay', stopped.status === 401
      && !!(await s.q<Loose>('SELECT disabled_at FROM pm.api_keys WHERE id = $1', [setupRow.id]))[0].disabled_at
      && (await s.q<Loose>('SELECT id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [viaKey?.data?.agent?.id])).length === 1, stopped.body);

    // A plain key that starts like a setup key is not one: only the server makes them.
    const forged = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await s.q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions) VALUES ('AI setup key', 'pk_live', $1, $2, $2, $3, 'scoped')`,
      [createHash('sha256').update(forged).digest('hex'), s.ana, ['tasks.read', 'projects.read']]);
    const forgedTools = await toolsOf({ key: forged });
    check('key: a key merely named like one gets no setup powers', !forgedTools.includes('hire_agent') && forgedTools.includes('search_tasks'), forgedTools);

    // No secret ever reaches the audit log.
    await settle();
    const allAudit = JSON.stringify(await s.q<Loose>('SELECT * FROM pm.api_audit_log'));
    check('audit: no setup key, agent key or token is logged', !allAudit.includes(setupKey) && !/pk_(live|setup)_[0-9a-f]{40}/.test(allAudit) && !/pmat_[0-9a-f]{8}/.test(allAudit));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`ai setup: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`ai setup: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
