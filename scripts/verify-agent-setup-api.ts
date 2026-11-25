/**
 * Setting up an agent by AI, over the real v1 API (withApi, supabase-js, a
 * fake PostgREST over PGlite and a stand-in for Supabase Auth's admin API)
 * and over MCP:
 * - End to end: create_agent, set_agent_projects, set_agent_rules,
 *   create_api_key (the key then works), create_webhook_endpoint, and
 *   get_agent_setup reads it all back.
 * - Escalation: a key grants only scopes it carries (fewer and equal pass,
 *   more is 403 scope_escalation, also for its own member) and only ones the
 *   target holds; only an Owner's key makes a key for someone else, and
 *   only for an agent (never another Owner or a person); project access
 *   only on projects the caller reaches; only an Owner adds an agent or an
 *   Admin; no key creates, promotes or changes an Owner.
 * - Lineage (20261124000400_agent_setup_api.sql): a key made by a key
 *   records it; revoking a key, over the API or in Settings, revokes every
 *   live descendant, each with its own audit row, and leaves its parent
 *   alive; a Settings key has no parent. The migration, run twice on the
 *   schema before it, matches schema.sql, and the lineage never changes.
 * - Read-only keys, keys without the permission and switched-off modules
 *   are refused.
 * - Secrets: shown in the creating answer only, never in lists, the setup
 *   read, the audit log or the idempotency store; Idempotency-Key is refused
 *   on those POSTs.
 * - Audit rows for every write; MCP lists the setup tools only to keys
 *   that hold their permissions, and their guide section with them.
 *
 *   npm run -s test:agent-setup-api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261124000400_agent_setup_api.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- API KEY LINEAGE (20261124000400_agent_setup_api.sql)';
const OWNER_LOGIN = '00000000-0000-4000-8000-00000000a001';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; headers: Headers };

const SETUP_SCOPES = ['team.manage', 'project_members.manage', 'api_keys.manage_all', 'webhooks.manage', 'tasks.read', 'tasks.create', 'projects.read', 'projects.manage'];

/** Supabase Auth's admin API, as much of it as creating a login needs. */
function authStandIn(db: PGlite) {
  const emails = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
      return true;
    };
    // The signed-in Owner behind a Settings session (signInAsOwner).
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: OWNER_LOGIN, aud: 'authenticated', role: 'authenticated', email: 'olivia@example.com', user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
    if (!url.pathname.startsWith('/auth/v1/admin/')) return false;
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const text = await new Promise<string>((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw));
      });
      const body = JSON.parse(text || '{}');
      const email = String(body.email).toLowerCase();
      if (emails.has(email)) return json(422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
      emails.add(email);
      const id = randomUUID();
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, email]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
    return json(404, { message: `No fake for ${request.method} ${url.pathname}` });
  };
}

/**
 * Session routes read the signed-in user from cookies (next/headers): this
 * hands them the Owner's session, as @supabase/ssr stores it.
 */
function signInAsOwner(supabaseUrl: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: OWNER_LOGIN, email: 'olivia@example.com', role: 'authenticated', aud: 'authenticated', exp })}.sig`;
  const session = {
    access_token: accessToken, refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: { id: OWNER_LOGIN, email: 'olivia@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-24T00:00:00Z' },
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

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the lineage section is there', at > 0 && banner > 0);
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('ALTER TABLE pm.api_keys')).replace(/\r\n/g, '\n').trim()));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const member = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'agent') RETURNING id")).rows[0].id;
  await old.query("INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Old key', 'pk_live', 'h1', $1, '{tasks.read}', 'scoped')", [member]);
  // This migration twice, then any later one, so schema.sql (which holds them all) is comparable.
  await applyMigrationsFrom(old, MIGRATION);
  const kept = (await old.query<Loose>('SELECT created_by_key_id FROM pm.api_keys')).rows;
  check('upgrade: an existing key has no parent', kept.length === 1 && kept[0].created_by_key_id === null, kept);
  // What 2.0.15 does still works: insert without the column, revoke one key by update.
  await old.query("INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('2.0.15 key', 'pk_live', 'h2', $1, '{tasks.read}', 'scoped')", [member]);
  const plain = await old.query("UPDATE pm.api_keys SET revoked_at = now() WHERE key_hash = 'h2' AND revoked_at IS NULL");
  check('upgrade: the previous release still makes and revokes keys', plain.affectedRows === 1);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await fresh.query<Loose>(`SELECT has_function_privilege('anon', 'pm.revoke_api_key_tree(uuid)', 'EXECUTE') AS anon,
    has_function_privilege('authenticated', 'pm.revoke_api_key_tree(uuid)', 'EXECUTE') AS authed,
    has_function_privilege('service_role', 'pm.revoke_api_key_tree(uuid)', 'EXECUTE') AS service`)).rows[0];
  check('revoke_api_key_tree: service role only', grants && !grants.anon && !grants.authed && grants.service, grants);
  const [a, b] = (await fresh.query<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, scopes, permissions)
    VALUES ('A', 'pk_live', 'ha', '{}', 'scoped'), ('B', 'pk_live', 'hb', '{}', 'scoped') RETURNING id`)).rows;
  const moved = await fresh.query('UPDATE pm.api_keys SET created_by_key_id = $1 WHERE id = $2', [a.id, b.id]).then(() => null, (e: Error) => e.message);
  check('guard: the lineage never changes', /lineage cannot change/.test(moved ?? ''), moved);
  await old.close();
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  // A 2.0 install: the server adds members (pm.add_team_member), no sign-up trigger.
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [OWNER_LOGIN, 'olivia@example.com']);
  await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [OWNER_LOGIN, owner]);
  const ada = await member('Ada', 'admin');
  const morgan = await member('Morgan', 'member');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.projects (name, created_at) VALUES ($1, now() - interval '1 day') RETURNING id", [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [ada, morgan]);
  const queue = await project('Queue', [morgan]);
  // Ada: an Admin granted the setup permissions on the api channel, but who
  // reaches only the projects she is on.
  for (const permission of ['team.manage', 'api_keys.manage_all', 'project_members.manage']) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow')", [ada, permission]);
  }
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny')", [ada]);
  const key = async (memberId: string, scopes: string[], permissions = 'scoped') => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, $4)`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes, permissions]);
    return secret;
  };
  const keys = {
    owner: await key(owner, SETUP_SCOPES),
    ownerNarrow: await key(owner, ['team.manage', 'api_keys.manage_all', 'tasks.read']),
    ownerReadOnly: await key(owner, SETUP_SCOPES, 'read_only'),
    ownerNoPermission: await key(owner, ['tasks.read']),
    ada: await key(ada, ['team.manage', 'api_keys.manage_all', 'project_members.manage', 'tasks.read', 'projects.read']),
  };
  return { q, owner, ada, morgan, apex, queue, keys };
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  signInAsOwner(server.url);
  try {
    const agentsRoute = await import('../src/app/api/v1/agents/route');
    const setupRoute = await import('../src/app/api/v1/agents/[id]/setup/route');
    const projectsRoute = await import('../src/app/api/v1/agents/[id]/projects/route');
    const keysRoute = await import('../src/app/api/v1/api-keys/route');
    const revokeRoute = await import('../src/app/api/v1/api-keys/[id]/revoke/route');
    const hooksRoute = await import('../src/app/api/v1/webhook-endpoints/route');
    const hookRoute = await import('../src/app/api/v1/webhook-endpoints/[id]/route');
    const membersRoute = await import('../src/app/api/v1/team-members/route');
    const memberRoute = await import('../src/app/api/v1/team-members/[id]/route');
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const settingsKeysRoute = await import('../src/app/api/workspace/api-keys/route');
    const settingsRevokeRoute = await import('../src/app/api/workspace/api-keys/[id]/revoke/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller, toolsFor } = await import('../src/lib/mcp/server');
    const { resolveApiKey } = await import('../src/lib/api/middleware');
    const { SETUP_TOOLS } = await import('../src/lib/mcp/guide');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const createAgent = (apiKey: string, body: unknown, headers?: Record<string, string>) => call(agentsRoute.POST, 'POST', '/api/v1/agents', {}, apiKey, body, headers);
    const setup = (apiKey: string, id: string) => call(setupRoute.GET, 'GET', `/api/v1/agents/${id}/setup`, { id }, apiKey);
    const projects = (apiKey: string, id: string, body: unknown) => call(projectsRoute.PATCH, 'PATCH', `/api/v1/agents/${id}/projects`, { id }, apiKey, body);
    const mint = (apiKey: string, body: unknown, headers?: Record<string, string>) => call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, apiKey, body, headers);
    const listKeys = (apiKey: string, query = '') => call(keysRoute.GET, 'GET', `/api/v1/api-keys${query}`, {}, apiKey);
    const addHook = (apiKey: string, body: unknown, headers?: Record<string, string>) => call(hooksRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, apiKey, body, headers);
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const keyCount = async () => (await s.q<{ n: number }>('SELECT count(*)::int AS n FROM pm.api_keys'))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    // --- Who may add an agent ---------------------------------------------------------------
    const readOnly = await createAgent(s.keys.ownerReadOnly, { name: 'Nope', email: 'nope@agents.example.com' });
    check('read-only key: refused for a write', readOnly.status === 403 && reason(readOnly) === 'read_only_key', readOnly);
    const noPermission = await createAgent(s.keys.ownerNoPermission, { name: 'Nope', email: 'nope@agents.example.com' });
    check('no permission: 403 naming the missing scope', noPermission.status === 403 && reason(noPermission) === 'missing_key_scope', noPermission);
    const byAdmin = await createAgent(s.keys.ada, { name: 'Nope', email: 'nope@agents.example.com' });
    check('only an Owner adds an agent, as on the Team page', byAdmin.status === 403 && reason(byAdmin) === 'owner_only', byAdmin);
    const asOwner = await createAgent(s.keys.owner, { name: 'Boss', email: 'boss@agents.example.com', role: 'owner' });
    check('create_agent: a role in the body is refused, so it can never make an Owner', asOwner.status === 422, asOwner);
    const noMembers = await s.q("SELECT id FROM pm.team_members WHERE email IN ('nope@agents.example.com', 'boss@agents.example.com')");
    check('refused calls made no member', noMembers.length === 0, noMembers);

    // --- End to end -------------------------------------------------------------------------
    const made = await createAgent(s.keys.owner, { name: 'Scout', email: 'scout@agents.example.com', title: 'Auditor', agent_profile: 'auditor' });
    const agent = made.body.data?.id as string;
    check('create_agent: an agent with its title and profile, made through a login', made.status === 201 && made.body.data?.role === 'agent'
      && made.body.data?.title === 'Auditor' && made.body.data?.agent_profile === 'auditor' && !!made.body.data?.auth_user_id, made.body);
    check('create_agent: no sign-in link is made', (await s.q('SELECT id FROM pm.team_invites WHERE member_id = $1', [agent])).length === 0);
    const taken = await createAgent(s.keys.owner, { name: 'Scout again', email: 'scout@agents.example.com' });
    check('create_agent: an email that already has a login is refused, not linked', taken.status === 409, taken);

    const added = await projects(s.keys.owner, agent, { add: [s.apex, s.queue] });
    check('set_agent_projects: adds the agent to both projects', added.status === 200 && JSON.stringify(added.body.data?.changed?.slice().sort()) === JSON.stringify([s.apex, s.queue].sort())
      && added.body.data?.projects?.length === 2, added.body);
    const membership = await s.q('SELECT project_id FROM pm.project_members WHERE member_id = $1', [agent]);
    check('set_agent_projects: the memberships are stored', membership.length === 2, membership);
    const projectLog = await s.q("SELECT user_id FROM pm.activities WHERE type = 'member.added' AND entity_id = $1", [agent]);
    check('set_agent_projects: the team activity log records it under the caller, as from the screen', projectLog.length === 2 && projectLog.every((row) => row.user_id === s.owner), projectLog);

    const rules = await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${agent}`, { id: agent }, s.keys.owner, { agent_close_policy: 'review', agent_escalate_to: s.morgan });
    check('set_agent_rules: the rules route fits the new agent', rules.status === 200 && rules.body.data?.agent_close_policy === 'review', rules.body);

    const before = await setup(s.keys.owner, agent);
    const available: string[] = before.body.data?.api_keys?.available_scopes ?? [];
    check('get_agent_setup: lists what a key for the agent may carry', available.includes('tasks.read') && available.includes('tasks.create') && !available.includes('team.manage'), available);

    const minted = await mint(s.keys.owner, { member_id: agent, name: 'Scout harness', scopes: ['tasks.read', 'projects.read'] });
    const secret = minted.body.data?.secret as string;
    check('create_api_key: the key and its secret, once', minted.status === 201 && /^pk_live_[0-9a-f]{48}$/.test(secret ?? '')
      && minted.body.data?.key?.team_member_id === agent && minted.body.data?.key?.created_by === s.owner
      && JSON.stringify(minted.body.data?.key?.scopes) === JSON.stringify(['tasks.read', 'projects.read']) && !('key_hash' in (minted.body.data?.key ?? {})), minted.body);
    check('create_api_key: not cached anywhere on the way', minted.headers.get('cache-control') === 'no-store');
    const works = await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, secret);
    check('create_api_key: the new key works as the agent', works.status === 200, works.status);

    const hook = await addHook(s.keys.owner, { name: 'Scout wake', url: 'https://hooks.example.com/scout', events: ['task.created', 'task.updated', 'comment.created'], project_ids: [s.apex], member_id: agent });
    const signing = hook.body.data?.secret as string;
    check('create_webhook_endpoint: the endpoint and its signing secret, once', hook.status === 201 && /^whsec_[0-9a-f]{64}$/.test(signing ?? '')
      && hook.body.data?.endpoint?.member_id === agent && JSON.stringify(hook.body.data?.endpoint?.project_ids) === JSON.stringify([s.apex])
      && !('secret' in (hook.body.data?.endpoint ?? {})), hook.body);
    const stored = (await s.q('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [hook.body.data?.endpoint?.id]))[0];
    check('create_webhook_endpoint: the stored secret is the one returned, so deliveries verify', stored?.secret === signing);

    const after = await setup(s.keys.owner, agent);
    const d = after.body.data ?? {};
    check('get_agent_setup: member and rules', after.status === 200 && d.member?.id === agent && d.member?.title === 'Auditor'
      && d.rules?.agent_close_policy === 'review' && d.rules?.agent_escalate_to === s.morgan && !('agent_close_policy' in (d.member ?? {})), d.member);
    check('get_agent_setup: projects with the reach they give', d.projects?.access === 'member' && d.projects?.projects?.length === 2 && d.projects?.hidden_count === 0, d.projects);
    check('get_agent_setup: the live key, without a secret', d.api_keys?.keys?.length === 1 && d.api_keys.keys[0].id === minted.body.data?.key?.id, d.api_keys);
    check('get_agent_setup: the webhook filtered to it, without a secret', d.webhooks?.length === 1 && !('secret' in d.webhooks[0]), d.webhooks);
    check('get_agent_setup: nothing omitted for a key that reads it all', Array.isArray(d.omitted) && d.omitted.length === 0, d.omitted);
    const adaView = await setup(s.keys.ada, agent);
    check('get_agent_setup: parts a key cannot read are null and named; projects it cannot reach are counted, not named', adaView.status === 200
      && adaView.body.data?.webhooks === null && adaView.body.data?.omitted?.some((o: Loose) => o.needs === 'webhooks.manage')
      && adaView.body.data?.api_keys !== null && adaView.body.data?.projects?.projects?.length === 1 && adaView.body.data?.projects?.hidden_count === 1, adaView.body.data);
    const personSetup = await setup(s.keys.owner, s.morgan);
    check('get_agent_setup: a person is not an agent', personSetup.status === 422, personSetup.status);

    // --- Secrets appear once ----------------------------------------------------------------
    const everywhere = JSON.stringify([(await listKeys(s.keys.owner)).body, (await call(hooksRoute.GET, 'GET', '/api/v1/webhook-endpoints', {}, s.keys.owner)).body, after.body]);
    check('secrets: never in the key list, the endpoint list or the setup read', !everywhere.includes(secret) && !everywhere.includes(signing) && !everywhere.includes('key_hash'));
    await settle();
    const auditText = JSON.stringify(await s.q('SELECT request_body, before_snapshot, after_snapshot FROM pm.api_audit_log'));
    check('secrets: never in the audit log', !auditText.includes(secret) && !auditText.includes(signing) && !auditText.includes('whsec_'));
    const count = await keyCount();
    const replayKey = await mint(s.keys.owner, { member_id: agent, name: 'Retry', scopes: ['tasks.read'] }, { 'idempotency-key': randomUUID() });
    check('secrets: Idempotency-Key is refused where the answer holds a secret, and nothing is made', replayKey.status === 400
      && reason(replayKey) === 'idempotency_not_supported' && (await keyCount()) === count, replayKey.body);
    const replayHook = await addHook(s.keys.owner, { name: 'Retry', url: 'https://hooks.example.com/r', events: ['task.created'] }, { 'idempotency-key': randomUUID() });
    check('secrets: the same for webhook endpoints', replayHook.status === 400 && reason(replayHook) === 'idempotency_not_supported', replayHook.body);
    const idemText = JSON.stringify(await s.q('SELECT response_body FROM pm.api_idempotency_keys'));
    check('secrets: never in the idempotency store', !idemText.includes('pk_live_') && !idemText.includes('whsec_'));

    // --- Key escalation ---------------------------------------------------------------------
    const fewer = await mint(s.keys.ownerNarrow, { member_id: agent, name: 'Fewer', scopes: ['tasks.read'] });
    check('mint: fewer scopes than the caller carries pass', fewer.status === 201, fewer.body);
    const equal = await mint(s.keys.ownerNarrow, { member_id: s.owner, name: 'Equal', scopes: ['team.manage', 'api_keys.manage_all', 'tasks.read'] });
    check('mint: exactly the caller\'s scopes pass (for its own member)', equal.status === 201, equal.body);
    const more = await mint(s.keys.ownerNarrow, { member_id: agent, name: 'More', scopes: ['tasks.read', 'tasks.create'] });
    check('mint: a scope the caller does not carry is 403 scope_escalation, though the agent holds it', more.status === 403 && reason(more) === 'scope_escalation'
      && JSON.stringify(more.body.error?.details?.beyond_caller) === JSON.stringify(['tasks.create']), more.body);
    const selfMore = await mint(s.keys.ownerNarrow, { member_id: s.owner, name: 'Self more', scopes: ['tasks.read', 'webhooks.manage'] });
    check('mint: a key never grants itself more, even for its own member', selfMore.status === 403 && reason(selfMore) === 'scope_escalation', selfMore.body);
    const notHeld = await mint(s.keys.owner, { member_id: agent, name: 'Not held', scopes: ['team.manage'] });
    check('mint: a scope the agent does not hold is 422 scope_not_held', notHeld.status === 422 && reason(notHeld) === 'scope_not_held', notHeld.body);
    const unknown = await mint(s.keys.owner, { member_id: agent, name: 'Unknown', scopes: ['access.manage'] });
    check('mint: an app-only permission is not an API scope', unknown.status === 422 && reason(unknown) === 'unknown_scope', unknown.body);
    const forOwner = await mint(s.keys.ada, { member_id: s.owner, name: 'Take over', scopes: ['tasks.read'] });
    check('mint: never a key for an Owner other than yourself', forOwner.status === 403 && reason(forOwner) === 'owner_protected', forOwner.body);
    const forPerson = await mint(s.keys.owner, { member_id: s.morgan, name: 'Impersonate', scopes: ['tasks.read'] });
    check('mint: never a key for another person, not even from an Owner', forPerson.status === 403 && reason(forPerson) === 'not_an_agent', forPerson.body);
    const adaForAgent = await mint(s.keys.ada, { member_id: agent, name: 'Read its inbox', scopes: ['tasks.read'] });
    check('mint: an Admin, even with api_keys.manage_all, never makes a key for an agent (it would act as the agent)', adaForAgent.status === 403
      && reason(adaForAgent) === 'owner_only', adaForAgent.body);
    const adaSelf = await mint(s.keys.ada, { member_id: s.ada, name: 'Mine', scopes: ['tasks.read'] });
    check('mint: an Admin may still make a key for her own member, within her key', adaSelf.status === 201, adaSelf.body);
    const adaSelfMore = await mint(s.keys.ada, { member_id: s.ada, name: 'Mine, more', scopes: ['tasks.read', 'tasks.create'] });
    check('mint: and not beyond her key, though her role holds it', adaSelfMore.status === 403 && reason(adaSelfMore) === 'scope_escalation', adaSelfMore.body);
    const adaQueue = await projects(s.keys.ada, agent, { add: [s.queue] });
    check('set_agent_projects: only on projects the caller reaches', adaQueue.status === 403 && reason(adaQueue) === 'project_scope', adaQueue.body);
    const keysNoPermission = await mint(s.keys.ownerNoPermission, { member_id: agent, name: 'x', scopes: ['tasks.read'] });
    check('mint: needs api_keys.manage_all', keysNoPermission.status === 403 && reason(keysNoPermission) === 'missing_key_scope', keysNoPermission.body);

    // --- Owners are never created, promoted or changed by a key --------------------------
    const ownerPost = await call(membersRoute.POST, 'POST', '/api/v1/team-members', {}, s.keys.owner, { name: 'Second', email: 'second@example.com', role: 'owner' });
    check('team-members: no key creates an Owner, not even an Owner\'s', ownerPost.status === 403 && reason(ownerPost) === 'owner_protected', ownerPost.body);
    const adaAgent = await call(membersRoute.POST, 'POST', '/api/v1/team-members', {}, s.keys.ada, { name: 'Side door', email: 'side@example.com', role: 'agent' });
    check('team-members: only an Owner adds an agent there too', adaAgent.status === 403 && reason(adaAgent) === 'owner_only', adaAgent.body);
    const promote = await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${agent}`, { id: agent }, s.keys.owner, { role: 'owner' });
    check('team-members: no key makes anyone an Owner', promote.status === 403 && reason(promote) === 'owner_protected', promote.body);
    const rename = await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${s.owner}`, { id: s.owner }, s.keys.ada, { email: 'mine@example.com' });
    check('team-members: another member\'s key cannot change an Owner', rename.status === 403 && reason(rename) === 'owner_protected', rename.body);
    const ownerProjects = await projects(s.keys.owner, s.owner, { add: [s.apex] });
    check('set_agent_projects: an Owner is never changed', ownerProjects.status === 403 && reason(ownerProjects) === 'owner_protected', ownerProjects.body);
    const ownerRow = (await s.q('SELECT role, email FROM pm.team_members WHERE id = $1', [s.owner]))[0];
    check('team-members: the Owner is as it was', ownerRow?.role === 'owner' && ownerRow?.email === 'olivia@example.com', ownerRow);

    // --- Webhook endpoints ------------------------------------------------------------------
    const http = await addHook(s.keys.owner, { name: 'Plain', url: 'http://hooks.example.com/x', events: ['task.created'] });
    check('webhooks: HTTPS only, as on the screen', http.status === 422, http.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'billing'");
    const invoice = await addHook(s.keys.owner, { name: 'Books', url: 'https://books.example.com/in', events: ['invoice.paid'] });
    check('webhooks: invoice events need Client invoicing', invoice.status === 422 && reason(invoice) === 'module_off', invoice.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'billing'");
    const ghost = await addHook(s.keys.owner, { name: 'Ghost', url: 'https://hooks.example.com/g', events: ['task.created'], project_ids: [randomUUID()] });
    check('webhooks: a project that does not exist is refused', ghost.status === 422, ghost.body);
    const hookId = hook.body.data?.endpoint?.id as string;
    const paused = await call(hookRoute.PATCH, 'PATCH', `/api/v1/webhook-endpoints/${hookId}`, { id: hookId }, s.keys.owner, { is_active: false, project_ids: null, events: ['task.created'] });
    check('webhooks: update pauses it and drops a filter', paused.status === 200 && paused.body.data?.is_active === false && paused.body.data?.project_ids === null
      && JSON.stringify(paused.body.data?.events) === JSON.stringify(['task.created']) && !('secret' in (paused.body.data ?? {})), paused.body);
    const hooksNoPermission = await call(hooksRoute.GET, 'GET', '/api/v1/webhook-endpoints', {}, s.keys.ada);
    check('webhooks: needs webhooks.manage', hooksNoPermission.status === 403, hooksNoPermission.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'webhooks'");
    const hooksOff = await call(hooksRoute.GET, 'GET', '/api/v1/webhook-endpoints', {}, s.keys.owner);
    check('webhooks: the Webhooks module switched off is MODULE_OFF', hooksOff.status === 403 && hooksOff.body.error?.code === 'MODULE_OFF', hooksOff.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'webhooks'");
    const deleted = await call(hookRoute.DELETE, 'DELETE', `/api/v1/webhook-endpoints/${hookId}`, { id: hookId }, s.keys.owner);
    check('webhooks: delete removes it', deleted.status === 200 && (await s.q('SELECT id FROM pm.webhook_endpoints WHERE id = $1', [hookId])).length === 0, deleted.body);

    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'agents'");
    const agentsOff = await createAgent(s.keys.owner, { name: 'Late', email: 'late@agents.example.com' });
    check('agents: the AI agents module switched off is MODULE_OFF', agentsOff.status === 403 && agentsOff.body.error?.code === 'MODULE_OFF', agentsOff.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'agents'");

    // --- Revoke -----------------------------------------------------------------------------
    const keyId = minted.body.data?.key?.id as string;
    const revoked = await call(revokeRoute.POST, 'POST', `/api/v1/api-keys/${keyId}/revoke`, { id: keyId }, s.keys.owner);
    check('revoke: the key is revoked', revoked.status === 200 && !!revoked.body.data?.revoked_at, revoked.body);
    const dead = await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, secret);
    check('revoke: the secret stops working', dead.status === 401, dead.status);
    const live = await listKeys(s.keys.owner, `?member_id=${agent}`);
    check('list_api_keys: live keys only by default', live.status === 200 && !live.body.data.some((k: Loose) => k.id === keyId), live.body);

    // --- Lineage: revoking a key revokes what it made ---------------------------------------
    const lineage = async (id: string) => (await s.q('SELECT created_by_key_id, revoked_at FROM pm.api_keys WHERE id = $1', [id]))[0];
    const fromSettings = await settingsKeysRoute.POST(new Request('http://localhost/api/workspace/api-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owner laptop', scopes: ['api_keys.manage_all', 'tasks.read'] }),
    }));
    const settingsBody = await fromSettings.json();
    const root = { id: settingsBody.data?.key?.id as string, secret: settingsBody.data?.secret as string };
    check('lineage: a key made in Settings has no parent', fromSettings.status === 200 && !!root.secret && (await lineage(root.id))?.created_by_key_id === null, settingsBody);
    const child = await mint(root.secret, { member_id: s.owner, name: 'Child', scopes: ['api_keys.manage_all', 'tasks.read'] });
    const grandchild = await mint(child.body.data?.secret, { member_id: agent, name: 'Grandchild', scopes: ['tasks.read'] });
    const childId = child.body.data?.key?.id as string;
    const grandchildId = grandchild.body.data?.key?.id as string;
    check('lineage: each key records the key that made it', child.status === 201 && grandchild.status === 201
      && (await lineage(childId))?.created_by_key_id === root.id && (await lineage(grandchildId))?.created_by_key_id === childId
      && grandchild.body.data?.key?.created_by_key_id === childId, [child.body, grandchild.body]);
    const cutChild = await call(revokeRoute.POST, 'POST', `/api/v1/api-keys/${childId}/revoke`, { id: childId }, s.keys.owner);
    check('lineage: revoking a key revokes what it made', cutChild.status === 200 && !!(await lineage(childId))?.revoked_at && !!(await lineage(grandchildId))?.revoked_at
      && JSON.stringify(cutChild.body.data?.cascaded_revokes) === JSON.stringify([grandchildId]), cutChild.body);
    check('lineage: and leaves the key that made it alive', !(await lineage(root.id))?.revoked_at
      && (await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, root.secret)).status === 200);
    check("lineage: the grandchild's secret stops working", (await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, grandchild.body.data?.secret)).status === 401);
    const cascadeAudit = await s.q("SELECT request_body, api_key_id, via FROM pm.api_audit_log WHERE entity_id = $1 AND endpoint LIKE '%/revoke'", [grandchildId]);
    check('lineage: the cascaded revoke has its own audit row naming its cause', cascadeAudit.length === 1 && cascadeAudit[0].request_body?.cascaded_from === childId
      && cascadeAudit[0].request_body?.depth === 1, cascadeAudit);
    const child2 = await mint(root.secret, { member_id: s.owner, name: 'Child 2', scopes: ['api_keys.manage_all', 'tasks.read'] });
    const grandchild2 = await mint(child2.body.data?.secret, { member_id: agent, name: 'Grandchild 2', scopes: ['tasks.read'] });
    const ids2 = [root.id, child2.body.data?.key?.id, grandchild2.body.data?.key?.id] as string[];
    const settingsRevoke = await settingsRevokeRoute.POST(new Request(`http://localhost/api/workspace/api-keys/${root.id}/revoke`, { method: 'POST' }), { params: Promise.resolve({ id: root.id }) });
    const revokedAll = await Promise.all(ids2.map(lineage));
    check('lineage: revoking in Settings revokes the whole tree', settingsRevoke.status === 200 && revokedAll.every((row) => !!row?.revoked_at), revokedAll);
    // The revoke route's own rows (the database also records each key's row change, under /app/api_keys).
    const appAudit = await s.q("SELECT entity_id, via, request_body FROM pm.api_audit_log WHERE via = 'app' AND entity_id = ANY($1::uuid[]) AND endpoint LIKE '/api/workspace/%'", [ids2]);
    check('lineage: one audit row per key revoked from Settings', appAudit.length === 3 && appAudit.filter((row) => row.request_body?.cascaded_from === root.id).length === 2, appAudit);

    // A self-minting chain of any length goes with its root: no depth cap.
    const chain: { id: string; secret: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const chainSecret = `pk_live_${randomUUID().replace(/-/g, '')}`;
      const row = (await s.q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, created_by_key_id, scopes, permissions)
        VALUES ($1, 'pk_live', $2, $3, $3, $4, '{tasks.read,api_keys.manage_all}', 'scoped') RETURNING id`,
      [`Chain ${i}`, createHash('sha256').update(chainSecret).digest('hex'), s.owner, chain[i - 1]?.id ?? null]))[0];
      chain.push({ id: row.id, secret: chainSecret });
    }
    const deepest = chain[chain.length - 1];
    check('lineage: the deepest key of a 60-key chain works before the revoke', (await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, deepest.secret)).status === 200);
    const cutChain = await call(revokeRoute.POST, 'POST', `/api/v1/api-keys/${chain[0].id}/revoke`, { id: chain[0].id }, s.keys.owner);
    const chainLive = await s.q('SELECT id FROM pm.api_keys WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL', [chain.map((key) => key.id)]);
    check('lineage: revoking the root revokes all 60 keys of a chain', cutChain.status === 200 && chainLive.length === 0 && cutChain.body.data?.cascaded_revokes?.length === 59, { live: chainLive.length, cascaded: cutChain.body.data?.cascaded_revokes?.length });
    check('lineage: the deepest key of the chain stops working', (await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, deepest.secret)).status === 401);

    // A key that names itself as its parent: the revoke ends and revokes it.
    const selfId = randomUUID();
    await s.q(`INSERT INTO pm.api_keys (id, name, key_prefix, key_hash, team_member_id, created_by, created_by_key_id, scopes, permissions)
      VALUES ($1, 'Own parent', 'pk_live', 'self-parent-hash', $2, $2, $1, '{tasks.read}', 'scoped')`, [selfId, s.owner]);
    const cutSelf = await call(revokeRoute.POST, 'POST', `/api/v1/api-keys/${selfId}/revoke`, { id: selfId }, s.keys.owner);
    check('lineage: a key that is its own parent is revoked, and the revoke ends', cutSelf.status === 200 && !!(await lineage(selfId))?.revoked_at
      && JSON.stringify(cutSelf.body.data?.cascaded_revokes) === '[]', cutSelf.body);

    // --- Audit ------------------------------------------------------------------------------
    await settle();
    const audit = await s.q<{ method: string; endpoint: string; entity_type: string }>('SELECT method, endpoint, entity_type FROM pm.api_audit_log');
    const logged = (method: string, endpoint: string) => audit.some((row) => row.method === method && row.endpoint === endpoint);
    check('audit: every setup write is logged, as v1 writes are', logged('POST', '/api/v1/agents') && logged('PATCH', `/api/v1/agents/${agent}/projects`)
      && logged('POST', '/api/v1/api-keys') && logged('POST', `/api/v1/api-keys/${keyId}/revoke`) && logged('POST', '/api/v1/webhook-endpoints')
      && logged('PATCH', `/api/v1/webhook-endpoints/${hookId}`) && logged('DELETE', `/api/v1/webhook-endpoints/${hookId}`), audit);

    // --- MCP --------------------------------------------------------------------------------
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const mcpAgent = await runTool(s.keys.owner, s.owner, 'create_agent', { name: 'Relay', email: 'relay@agents.example.com', idempotency_key: randomUUID() });
    check('MCP: create_agent', mcpAgent?.ok === true && mcpAgent.data?.role === 'agent', mcpAgent);
    const mcpKey = await runTool(s.keys.owner, s.owner, 'create_api_key', { agent_id: mcpAgent.data?.id, name: 'Relay key', scopes: ['tasks.read'], read_only: true });
    check('MCP: create_api_key returns the secret once, read-only when asked', mcpKey?.ok === true && /^pk_live_/.test(mcpKey.data?.secret ?? '') && mcpKey.data?.key?.permissions === 'read_only', mcpKey);
    const mcpMore = await runTool(s.keys.ownerNarrow, s.owner, 'create_api_key', { agent_id: mcpAgent.data?.id, name: 'More', scopes: ['tasks.create'] });
    check('MCP: the same escalation rule, as a result the caller can read', mcpMore?.ok === false && mcpMore.status === 403 && mcpMore.error?.reason === 'scope_escalation', mcpMore);
    const mcpSetup = await runTool(s.keys.owner, s.owner, 'get_agent_setup', { agent_id: mcpAgent.data?.id });
    check('MCP: get_agent_setup shows the read-only key, no secret', mcpSetup?.ok === true && mcpSetup.data?.api_keys?.keys?.[0]?.permissions === 'read_only'
      && !JSON.stringify(mcpSetup).includes(mcpKey.data?.secret), mcpSetup?.error);

    const visible = async (apiKey: string) => {
      const { access, keyRow } = await resolveApiKey(apiKey);
      return toolsFor({ access, scopes: keyRow.scopes ?? [], readOnly: keyRow.permissions === 'read_only', profile: 'generic' }).map((t) => t.name);
    };
    const ownerTools = await visible(s.keys.owner);
    const agentTools = await visible(fewer.body.data?.secret);
    check('MCP: an Owner key with the permissions sees every setup tool', SETUP_TOOLS.every((name) => ownerTools.includes(name)), SETUP_TOOLS.filter((name) => !ownerTools.includes(name)));
    check('MCP: an agent key sees none of them', !SETUP_TOOLS.some((name) => agentTools.includes(name)), agentTools);
    check('MCP: a read-only key sees no setup write tool', !(await visible(s.keys.ownerReadOnly)).some((name) => ['create_agent', 'create_api_key', 'create_webhook_endpoint', 'set_agent_projects'].includes(name)));
    check('MCP: create tools that return a secret take no idempotency_key', ['create_api_key', 'create_webhook_endpoint'].every((name) => !('idempotency_key' in (PM_TOOLS.find((t) => t.name === name)?.input.shape ?? {}))));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent setup API: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`agent setup API: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
