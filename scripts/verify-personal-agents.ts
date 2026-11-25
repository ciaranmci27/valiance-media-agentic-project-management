/**
 * Personal agents and secrets at scale, end to end over the real routes
 * (session routes with a signed-in member, v1 routes with keys, MCP tools
 * through routeCaller, a fake PostgREST over PGlite with the full schema, a
 * stand-in for Supabase Auth):
 * - The migration (20261124001300_personal_agents_secrets.sql), run twice on
 *   the schema before it, matches schema.sql; rows from before keep null in
 *   every new column; the previous release's writes still work; the
 *   database guards who an agent works for, one per person per template, and
 *   key lineage; the new functions are service role only.
 * - A personal agent's access is always its own and its person's together,
 *   with or without X-Act-For: only its person's projects, its person as
 *   principal_id, a token for anyone else refused; its own bell open, inboxes
 *   closed; the person owns it and is who it escalates to.
 * - Assistant setups (Owner only), bulk provisioning (dry run, idempotent,
 *   paged), auto-provisioning on join.
 * - The harness collects each key once (assistants.provision), revoking the
 *   harness key revokes what it collected.
 * - A person makes and rotates keys for their own personal agent only, never
 *   past their own access.
 * - Key lifetime, expiry 401, rotation with overlap and the old key revoked
 *   once the window ends (time simulated).
 * - The deprovision cascade (pause, key trees, delegation tokens, link
 *   requests, ownership, audit) and reactivation (resumes only what it
 *   paused, never restores a key).
 * - The live fleet's keys are untouched throughout.
 * - Webhook secrets sealed at rest with signing intact, the plaintext
 *   fallback without APP_ENCRYPTION_KEY, the lazy move and the re-encrypt.
 * - Scale: 500 members provisioned in two pages, then nothing to do.
 *
 *   npm run -s test:personal-agents
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import type { AccessContext } from '../src/lib/access-control';
import { assistantNameFor, personalAgentBrief } from '../src/lib/personal-agents';
import { canHaveSignIn } from '../src/lib/team/invite-rules';
import { personalAgentAccess } from '../src/lib/api/access';
import { openWebhookSecret, sealWebhookSecret } from '../src/lib/webhooks/secret';
import { verifySignatureHeader } from '../src/lib/webhooks/sign';
import { runDispatch, SEALED_SECRET_UNREADABLE, type ClaimedDelivery, type DispatchStore } from '../src/lib/webhooks/dispatch';

const MIGRATION = '20261124001300_personal_agents_secrets.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- PERSONAL AGENTS AND SECRETS AT SCALE (20261124001300_personal_agents_secrets.sql)';
const APP_KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

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
  owner: { id: '00000000-0000-4000-8000-00000000c001', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000c002', email: 'ana@example.com' },
  ben: { id: '00000000-0000-4000-8000-00000000c003', email: 'ben@example.com' },
};
let signedIn = LOGINS.owner;

/** Supabase Auth: the signed-in user of the moment, and creating logins. */
function authStandIn(db: PGlite) {
  const emails = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
      return true;
    };
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
    const userMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
    if (userMatch && request.method === 'GET') {
      await db.exec('RESET ROLE');
      const user = (await db.query<{ id: string; email: string }>('SELECT id, email FROM auth.users WHERE id = $1', [userMatch[1]])).rows[0];
      if (!user) return json(404, { code: 'user_not_found', message: 'User not found' });
      return json(200, { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, last_sign_in_at: null, user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
    }
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
  check('names: from the setup\'s template', assistantNameFor('Ana Lopez') === "Ana's Assistant" && assistantNameFor('Ana Lopez', '{name} helper') === 'Ana Lopez helper');
  check('brief: says whose it is and what it sees', /You work for Ana/.test(personalAgentBrief('Ana')) && /see only what Ana can see/.test(personalAgentBrief('Ana')));
  const agent: AccessContext = { member_id: 'a', role: 'agent', status: 'active', app_permissions: [], api_permissions: ['projects.read', 'tasks.read', 'agent_activity.write', 'project_context.read'], project_ids: [] };
  const ana: AccessContext = { member_id: 'm', role: 'member', status: 'active', app_permissions: [], api_permissions: ['projects.read', 'tasks.read', 'reminders.manage_own'], project_ids: ['p1', 'p3'] };
  const both = personalAgentAccess(agent, ana);
  check('personal access: exactly the person\'s projects, though the agent is on none', JSON.stringify(both.project_ids) === JSON.stringify(['p1', 'p3']), both.project_ids);
  check('personal access: only permissions both hold, plus its own activity log', JSON.stringify([...both.api_permissions].sort()) === JSON.stringify(['agent_activity.write', 'projects.read', 'tasks.read']), both.api_permissions);
  check('personal access: names the person, stays the agent', both.principal_id === 'm' && both.member_id === 'a' && both.role === 'agent');
  const reader = personalAgentAccess(agent, { ...ana, api_permissions: [...ana.api_permissions, 'projects.read_all'] });
  check('personal access: a person who reads every project lends that reach', reader.api_permissions.includes('projects.read_all'), reader.api_permissions);
  const noProjects = personalAgentAccess({ ...agent, api_permissions: ['tasks.read'] }, ana);
  check('personal access: an agent denied projects.read gains no reach', noProjects.project_ids.length === 0 && !noProjects.api_permissions.includes('projects.read_all'), noProjects);
  check('personal access: a suspended person suspends it', personalAgentAccess(agent, { ...ana, status: 'suspended' }).status === 'suspended');
  const sealed = sealWebhookSecret('e1', 'whsec_x', { APP_ENCRYPTION_KEY: APP_KEY });
  check('webhook secret: sealed with the key, opened only for its own endpoint', sealed.startsWith('pm1:') && openWebhookSecret('e1', sealed, { APP_ENCRYPTION_KEY: APP_KEY }) === 'whsec_x'
    && (() => { try { openWebhookSecret('e2', sealed, { APP_ENCRYPTION_KEY: APP_KEY }); return false; } catch { return true; } })());
  check('webhook secret: stored as given without the key', sealWebhookSecret('e1', 'whsec_x', {}) === 'whsec_x' && openWebhookSecret('e1', 'whsec_x', {}) === 'whsec_x');
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the personal agents section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Personal agents')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => old.query(sql, params).then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  const pat = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const quinn = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Quinn', 'quinn@example.com', 'member') RETURNING id"))[0].id;
  const fleet = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent') RETURNING id"))[0].id;
  const key = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Fleet key', 'pk_live', 'hash-old', $1, $1, '{tasks.read}', 'scoped') RETURNING id`, [fleet]))[0].id;
  const hook = (await q<{ id: string }>("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Old', 'https://hooks.example.test/o', 'whsec_old', '{task.created}') RETURNING id"))[0].id;

  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();

  const kept = (await q<Loose>('SELECT k.expires_at, k.rotated_from, k.revoked_at, m.delegate_of, m.assistant_template, m.delegate_paused_at FROM pm.api_keys k JOIN pm.team_members m ON m.id = k.team_member_id WHERE k.id = $1', [key]))[0];
  check('upgrade: an existing key and agent keep null in every new column', kept.expires_at === null && kept.rotated_from === null && kept.revoked_at === null
    && kept.delegate_of === null && kept.assistant_template === null && kept.delegate_paused_at === null, kept);
  check('upgrade: an existing webhook secret is untouched (the key is not in the database)', (await q<Loose>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [hook]))[0].secret === 'whsec_old');
  check('upgrade: agent key lifetime starts unset (never)', ((await q<Loose>('SELECT agent_key_lifetime_days FROM pm.business_settings LIMIT 1'))[0]?.agent_key_lifetime_days ?? null) === null);
  // What 2.0.23 writes: a member suspended and back, a key without the new columns.
  check('upgrade: the previous release suspends and reactivates a person with no personal agent', (await fail("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [pat])) === null
    && (await fail("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [pat])) === null);
  check('upgrade: a 2.0.23-shaped key insert still works', (await fail(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('New', 'pk_live', 'hash-new', $1, $1, '{tasks.read}', 'scoped')`, [fleet])) === null);

  // Who an agent works for.
  check('database: only an agent works for someone', /Only an agent works for someone/.test(await fail("INSERT INTO pm.team_members (name, email, role, delegate_of) VALUES ('X', 'x@example.com', 'member', $1)", [pat]) ?? ''));
  check('database: never for an agent', /never for an agent/.test(await fail("INSERT INTO pm.team_members (name, email, role, delegate_of) VALUES ('Y', 'y@example.com', 'agent', $1)", [fleet]) ?? ''));
  const mine = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ('Pat''s Assistant', 'pa@agents.invalid', 'agent', $1, 'personal-assistant') RETURNING id", [pat]))[0].id;
  check('database: the person owns their personal agent', (await q<Loose>('SELECT member_id FROM pm.agent_owners WHERE agent_id = $1', [mine])).map((r: Loose) => r.member_id).join() === pat);
  check('database: one personal agent per person per template', /team_members_one_assistant_per_template/.test(await fail("INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ('Again', 'pa2@agents.invalid', 'agent', $1, 'personal-assistant')", [pat]) ?? ''));
  check('database: who it works for never changes by a plain write', /changes only by an Owner/.test(await fail('UPDATE pm.team_members SET delegate_of = $1 WHERE id = $2', [quinn, mine]) ?? '')
    && /changes only by an Owner/.test(await fail('UPDATE pm.team_members SET delegate_of = NULL WHERE id = $1', [mine]) ?? ''));
  await q('SELECT * FROM pm.set_agent_delegate($1, $2)', [mine, quinn]);
  const owners = (await q<Loose>('SELECT member_id FROM pm.agent_owners WHERE agent_id = $1', [mine])).map((r: Loose) => r.member_id);
  check('database: pm.set_agent_delegate moves it, and its ownership', owners.join() === quinn && (await q<Loose>('SELECT delegate_of FROM pm.team_members WHERE id = $1', [mine]))[0].delegate_of === quinn, owners);
  check('database: the flag does not outlive the change', /changes only by an Owner/.test(await fail('UPDATE pm.team_members SET delegate_of = $1 WHERE id = $2', [pat, mine]) ?? ''));
  check('database: a person with a personal agent never becomes an agent', /cannot become an agent/.test(await fail("UPDATE pm.team_members SET role = 'agent' WHERE id = $1", [quinn]) ?? ''));
  check('database: a personal agent never stops being an agent', /Only an agent works for someone/.test(await fail("UPDATE pm.team_members SET role = 'member' WHERE id = $1", [mine]) ?? ''));
  check('database: rotated_from never changes', /lineage cannot change/.test(await fail('UPDATE pm.api_keys SET rotated_from = $1 WHERE id = $1', [key]) ?? ''));
  await q("UPDATE pm.api_keys SET revoked_at = now() WHERE id = $1", [key]);
  check('database: a revoked key cannot be rotated', /cannot be rotated/.test(await fail("SELECT pm.rotate_api_key($1, 'pk_x', 'hash-x', NULL, NULL, 60)", [key]) ?? ''));
  const grants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('set_agent_delegate', 'provision_personal_agents', 'rotate_api_key', 'revoke_rotated_api_keys', 'audit_member_cascade')`);
  check('grants: the new functions are the server\'s only', grants.length === 5 && grants.every((g: Loose) => !g.anon && !g.auth && (g.name === 'audit_member_cascade' || g.svc)), grants);
  const setupGrants = (await q<Loose>("SELECT has_table_privilege('authenticated', 'pm.assistant_setups', 'SELECT') AS auth, has_table_privilege('anon', 'pm.assistant_setups', 'SELECT') AS anon"))[0];
  check('grants: assistant setups are the server\'s only', !setupGrants.auth && !setupGrants.anon, setupGrants);
  await old.close();
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
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const ana = await member('Ana Lopez', 'member', LOGINS.ana);
  const ben = await member('Ben Ode', 'member', LOGINS.ben);
  const jeff = await member('Jeff', 'agent');
  const helper = await member('Helper', 'agent');
  for (const m of [ana, ben]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny'), ($1, 'projects.read_all', 'app', 'deny') ON CONFLICT DO NOTHING", [m]);
  }
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const anaOnly = await project('Ana work', [ana]);
  const benOnly = await project('Ben work', [ben, jeff]);
  const shared = await project('Shared', [ana, ben, jeff]);
  const key = async (memberId: string, scopes: string[], extra: { expires?: string } = {}) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions, expires_at)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped', $4) RETURNING id`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes, extra.expires ?? null]))[0].id;
    return { secret: secretKey, id };
  };
  const TEMPLATE_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'reminders.manage_own', 'notifications.manage_own', 'agent_activity.write'];
  const keys = {
    owner: await key(owner, ['team.read', 'team.manage', 'api_keys.manage_all', 'webhooks.manage', 'projects.read', 'tasks.read']),
    harness: await key(owner, ['assistants.provision', ...TEMPLATE_SCOPES]),
    harnessNarrow: await key(owner, ['assistants.provision', 'tasks.read']),
    jeff: await key(jeff, ['tasks.read', 'projects.read', 'tasks.create']),
    anaOwn: await key(ana, ['tasks.read', 'projects.read']),
  };
  return { q, owner, ana, ben, jeff, helper, anaOnly, benOnly, shared, keys, TEMPLATE_SCOPES };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  delete process.env.APP_ENCRYPTION_KEY;
  installSession(server.url);
  try {
    const setupsRoute = await import('../src/app/api/workspace/assistants/setups/route');
    const setupRoute = await import('../src/app/api/workspace/assistants/setups/[id]/route');
    const provisionRoute = await import('../src/app/api/workspace/assistants/provision/route');
    const assistantsRoute = await import('../src/app/api/workspace/assistants/route');
    const meRoute = await import('../src/app/api/workspace/assistants/me/route');
    const bindRoute = await import('../src/app/api/workspace/assistants/bind/route');
    const ownKeyRoute = await import('../src/app/api/workspace/assistants/[id]/keys/route');
    const sessionRotate = await import('../src/app/api/workspace/api-keys/[id]/rotate/route');
    const keySettings = await import('../src/app/api/workspace/key-settings/route');
    const inviteRoute = await import('../src/app/api/team-members/invite/route');
    const memberRoute = await import('../src/app/api/workspace/team-members/[id]/route');
    const secretRoute = await import('../src/app/api/workspace/webhook-endpoints/[id]/secret/route');
    const agentsRoute = await import('../src/app/api/workspace/agents/route');
    const reissueRoute = await import('../src/app/api/team-members/[id]/invite/route');
    const { issueInvite, peekInvite } = await import('../src/lib/team/invite');
    const v1Assistants = await import('../src/app/api/v1/assistants/route');
    const v1Claim = await import('../src/app/api/v1/assistants/[id]/key/route');
    const v1Provision = await import('../src/app/api/v1/assistants/provision/route');
    const v1Setups = await import('../src/app/api/v1/assistant-setups/route');
    const v1Rotate = await import('../src/app/api/v1/api-keys/[id]/rotate/route');
    const v1Revoke = await import('../src/app/api/v1/api-keys/[id]/revoke/route');
    const v1Projects = await import('../src/app/api/v1/projects/route');
    const v1Project = await import('../src/app/api/v1/projects/[id]/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Notifications = await import('../src/app/api/v1/notifications/route');
    const v1Inbox = await import('../src/app/api/v1/inbound-emails/route');
    const v1Webhooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { escalationTarget } = await import('../src/lib/api/agent-rules');
    const { reencryptAll, encryptionStatus } = await import('../src/lib/crypto/reencrypt');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const sessionNext = async (handler: (request: NextRequest) => Promise<Response>, path: string, body: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, actFor?: string) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor !== undefined ? { 'x-act-for': actFor } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const projectIds = (answer: Answer) => ((answer.body?.data ?? []) as Loose[]).map((p) => p.id).sort();
    const jeffWorks = async (label: string) => {
      const answer = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.jeff.secret);
      const row = (await s.q<Loose>('SELECT expires_at, revoked_at, rotated_from FROM pm.api_keys WHERE id = $1', [s.keys.jeff.id]))[0];
      check(`live fleet: Jeff's key untouched and working (${label})`, answer.status === 200 && row.expires_at === null && row.revoked_at === null && row.rotated_from === null, { status: answer.status, row });
    };
    await jeffWorks('before');

    // ── Setups ──────────────────────────────────────────────────────────
    as(LOGINS.ana);
    const anaSetup = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'member' });
    check('setups: a member cannot add one', anaSetup.status === 403 && reason(anaSetup) === 'owner_only', anaSetup.body);
    as(LOGINS.owner);
    const memberSetup = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'member', settings: { title: 'Assistant' } });
    const setupId = memberSetup.body?.data?.id as string;
    check('setups: an Owner gives members a personal assistant each', memberSetup.status === 201 && memberSetup.body.data.template_key === 'personal-assistant'
      && memberSetup.body.data.match_role === 'member' && memberSetup.body.data.enabled === true, memberSetup.body);
    const dupe = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'member' });
    check('setups: the same role and template twice is 409 setup_exists', dupe.status === 409 && reason(dupe) === 'setup_exists', dupe.body);
    const both = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'guest', match_group_id: randomUUID() });
    check('setups: a role or a group, never both', both.status === 422, both.body);
    const unknownTemplate = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'admin', template_key: 'no-such-thing' });
    check('setups: an unknown template is refused', unknownTemplate.status === 422 && reason(unknownTemplate) === 'unknown_template', unknownTemplate.body);
    const listed = await session(setupsRoute.GET, 'GET', '/api/workspace/assistants/setups');
    check('setups: listed with the template label', listed.status === 200 && listed.body.data.setups.length === 1 && listed.body.data.setups[0].template_label === 'Personal assistant', listed.body);
    const viaKey = await v1(v1Setups.GET, 'GET', '/api/v1/assistant-setups', {}, s.keys.harness.secret);
    check('setups: the v1 list answers the same for an Owner\'s provisioning key', viaKey.status === 200 && viaKey.body.data.length === 1, viaKey.body);
    const ownerNoScope = await v1(v1Setups.GET, 'GET', '/api/v1/assistant-setups', {}, s.keys.owner.secret);
    check('setups: a key without assistants.provision is refused', ownerNoScope.status === 403, ownerNoScope.body);

    // ── Bulk provisioning ──────────────────────────────────────────────
    const dry = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, { dry_run: true });
    check('provision: a dry run names everyone missing one and writes nothing', dry.status === 200 && dry.body.data.dry_run === true && dry.body.data.total_missing === 2
      && dry.body.data.agents.map((a: Loose) => a.person.id).sort().join() === [s.ana, s.ben].sort().join()
      && await count('SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of IS NOT NULL') === 0, dry.body);
    const dryPage = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, { dry_run: true, limit: 1 });
    const dryNext = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, { dry_run: true, limit: 1, after: dryPage.body?.data?.next_after });
    check('provision: a dry run pages with after', dryPage.body?.data?.agents?.length === 1 && !!dryPage.body.data.next_after && dryNext.body?.data?.agents?.length === 1
      && dryNext.body.data.next_after === null && dryNext.body.data.agents[0].person.id !== dryPage.body.data.agents[0].person.id, [dryPage.body, dryNext.body]);
    as(LOGINS.ana);
    const anaProvision = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, {});
    check('provision: a member cannot provision', anaProvision.status === 403, anaProvision.body);
    as(LOGINS.owner);
    const made = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, {});
    check('provision: makes one each, keyless', made.status === 200 && made.body.data.agents.filter((a: Loose) => a.agent_id).length === 2 && made.body.data.remaining === 0
      && await count('SELECT count(*)::int AS n FROM pm.api_keys k JOIN pm.team_members m ON m.id = k.team_member_id WHERE m.delegate_of IS NOT NULL') === 0, made.body);
    const again = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, {});
    check('provision: idempotent, a second run makes nothing', again.status === 200 && again.body.data.agents.length === 0 && again.body.data.total_missing === 0
      && await count('SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of IS NOT NULL') === 2, again.body);
    const anaAgent = (await s.q<Loose>('SELECT * FROM pm.team_members WHERE delegate_of = $1', [s.ana]))[0];
    const benAgent = (await s.q<Loose>('SELECT * FROM pm.team_members WHERE delegate_of = $1', [s.ben]))[0];
    check('provision: named, labelled and set up from the template, escalating to its person', anaAgent.name === "Ana's Assistant" && anaAgent.title === 'Assistant' && anaAgent.role === 'agent'
      && anaAgent.agent_role === 'assistant' && anaAgent.assistant_template === 'personal-assistant' && anaAgent.agent_escalate_to === s.ana && anaAgent.agent_self_assign === false, anaAgent);
    check('provision: the person owns it', (await s.q<Loose>('SELECT member_id FROM pm.agent_owners WHERE agent_id = $1', [anaAgent.id])).map((r: Loose) => r.member_id).join() === s.ana);
    check('provision: the audit row records the template, so the context pack knows it', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_id = $1 AND endpoint = '/api/workspace/agents' AND request_body->>'template' = 'personal-assistant'", [anaAgent.id]) === 1);
    check('escalation: a personal agent escalates to its person', await escalationTarget(service, anaAgent.id) === s.ana);
    const everyone = await session(assistantsRoute.GET, 'GET', '/api/workspace/assistants?needs_key=true');
    check('assistants: the Owner lists them, both waiting for a key', everyone.status === 200 && everyone.body.data.assistants.length === 2 && everyone.body.data.meta.total === 2, everyone.body);
    const agentsList = await session(agentsRoute.GET, 'GET', '/api/workspace/agents');
    const onlyPersonal = await session(agentsRoute.GET, 'GET', '/api/workspace/agents?personal=only');
    check('agents: the Agents list leaves personal agents out by default; personal=only lists them', agentsList.status === 200
      && !agentsList.body.data.agents.some((a: Loose) => a.id === anaAgent.id) && agentsList.body.data.agents.some((a: Loose) => a.id === s.jeff)
      && onlyPersonal.body?.data?.agents?.length === 2, [agentsList.body?.data?.meta, onlyPersonal.body?.data?.meta]);
    as(LOGINS.ana);
    const anaMine = await session(meRoute.GET, 'GET', '/api/workspace/assistants/me');
    const anaAll = await session(assistantsRoute.GET, 'GET', '/api/workspace/assistants');
    check('assistants: a person sees their own, never everyone\'s', anaMine.status === 200 && anaMine.body.data.assistants.length === 1 && anaMine.body.data.assistants[0].id === anaAgent.id
      && anaAll.status === 403, [anaMine.body, anaAll.status]);
    as(LOGINS.owner);

    // ── The harness collects each key once ─────────────────────────────
    const waiting = await v1(v1Assistants.GET, 'GET', '/api/v1/assistants?needs_key=true', {}, s.keys.harness.secret);
    check('harness: lists the agents waiting for a key', waiting.status === 200 && waiting.body.data.length === 2, waiting.body);
    const notHarness = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${anaAgent.id}/key`, { id: anaAgent.id }, s.keys.owner.secret, {});
    check('harness: a key without assistants.provision collects nothing', notHarness.status === 403, notHarness.body);
    const claim = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${anaAgent.id}/key`, { id: anaAgent.id }, s.keys.harness.secret, {});
    const anaKey = claim.body?.data?.secret as string;
    const anaKeyId = claim.body?.data?.key?.id as string;
    check('harness: collects the key, once, narrowed to what Ana and her agent both hold', claim.status === 201 && /^pk_live_/.test(anaKey ?? '')
      // project_context.read Ana lacks; the Inbox scopes this harness key does not carry.
      && claim.body.data.left_out.join() === 'project_context.read,inbound_email.read,inbound_email.triage' && claim.headers.get('cache-control') === 'no-store'
      && (await s.q<Loose>('SELECT created_by_key_id FROM pm.api_keys WHERE id = $1', [anaKeyId]))[0]?.created_by_key_id === s.keys.harness.id, claim.body);
    const twice = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${anaAgent.id}/key`, { id: anaAgent.id }, s.keys.harness.secret, {});
    check('harness: a second collect is 409 key_exists', twice.status === 409 && reason(twice) === 'key_exists', twice.body);
    const narrow = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${benAgent.id}/key`, { id: benAgent.id }, s.keys.harnessNarrow.secret, {});
    check('harness: a key that carries fewer scopes hands out only those', narrow.status === 201 && narrow.body.data.key.scopes.join() === 'tasks.read', narrow.body);
    const notPersonal = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${s.helper}/key`, { id: s.helper }, s.keys.harness.secret, {});
    check('harness: a shared agent is not a personal agent', notPersonal.status === 404, notPersonal.body);
    const idem = await read(await v1Claim.POST(new NextRequest(`http://localhost/api/v1/assistants/${benAgent.id}/key`, {
      method: 'POST', headers: { 'x-api-key': s.keys.harness.secret, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}',
    }), { params: Promise.resolve({ id: benAgent.id }) } as never));
    check('harness: the Idempotency-Key header is refused (a secret is never stored)', idem.status === 400 && reason(idem) === 'idempotency_not_supported', idem.body);

    // ── Always intersected, with or without X-Act-For ──────────────────
    const reach = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey);
    check('intersect: without X-Act-For it reaches exactly Ana\'s projects', reach.status === 200 && JSON.stringify(projectIds(reach)) === JSON.stringify([s.anaOnly, s.shared].sort()), reach.body);
    const benProject = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.benOnly}`, { id: s.benOnly }, anaKey);
    check('intersect: a project out of Ana\'s reach is out of its reach', benProject.status === 403 && reason(benProject) === 'project_scope', benProject.body);
    const task = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, anaKey, { project_id: s.anaOnly, title: 'Follow up with the client' });
    await settle();
    const taskRow = task.body?.data?.id ? (await s.q<Loose>('SELECT principal_id FROM pm.tasks WHERE id = $1', [task.body.data.id]))[0] : null;
    check('intersect: what it makes records Ana as principal_id', task.status === 201 && taskRow?.principal_id === s.ana, { status: task.status, body: task.body, taskRow });
    const outside = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, anaKey, { project_id: s.benOnly, title: 'Not mine' });
    check('intersect: it cannot create where Ana cannot', outside.status === 403, outside.body);
    const bell = await v1(v1Notifications.GET, 'GET', '/api/v1/notifications', {}, anaKey);
    check('intersect: its own bell stays open', bell.status === 200, bell.body);
    const inbox = await v1(v1Inbox.GET, 'GET', '/api/v1/inbound-emails', {}, anaKey);
    check('intersect: without Inbox scopes on its key, the Inbox stays closed', inbox.status === 403, inbox.body);
    const tokenFor = async (principal: string) => {
      const token = `pd_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
      await s.q(`INSERT INTO pm.delegation_tokens (token_hash, agent_id, principal_id, minted_via, expires_at) VALUES ($1, $2, $3, 'session', now() + interval '15 minutes')`,
        [createHash('sha256').update(token).digest('hex'), anaAgent.id, principal]);
      return token;
    };
    const forBen = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey, undefined, await tokenFor(s.ben));
    check('intersect: a token for anyone else is 403 delegate_only', forBen.status === 403 && reason(forBen) === 'delegate_only', forBen.body);
    const forAna = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey, undefined, await tokenFor(s.ana));
    check('intersect: a token for Ana answers the same as none', forAna.status === 200 && JSON.stringify(projectIds(forAna)) === JSON.stringify(projectIds(reach)), forAna.body);
    const pack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context', {}, anaKey);
    const packed = pack.body?.data?.pack;
    check('context: a personal agent knows whose it is', pack.status === 200 && packed?.works_for?.id === s.ana && /You work for Ana Lopez/.test(packed.works_for.says)
      && /You work for Ana Lopez/.test(packed.conventions[0]), packed?.works_for ?? pack.body);
    const md = await read(await v1MyContext.GET(new NextRequest('http://localhost/api/v1/agents/me/context?format=md', { headers: { 'x-api-key': anaKey } }), { params: Promise.resolve({}) } as never));
    check('context: the AGENTS.md says it first', md.status === 200 && /## Who you are\n\n- You work for Ana Lopez/.test(md.text), md.text.slice(0, 600));

    // ── A person and their own personal agent's keys ───────────────────
    as(LOGINS.ana);
    const own = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${anaAgent.id}/keys`, { id: anaAgent.id }, { name: 'My laptop', scopes: ['tasks.read', 'projects.read'] });
    check('own key: Ana makes a key for her own personal agent', own.status === 201 && /^pk_live_/.test(own.body?.data?.secret ?? '') && own.body.data.key.team_member_id === anaAgent.id, own.body);
    const beyond = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${anaAgent.id}/keys`, { id: anaAgent.id }, { scopes: ['project_context.read'] });
    check('own key: never past what Ana holds herself', beyond.status === 422 && reason(beyond) === 'scope_not_held', beyond.body);
    const teamScope = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${anaAgent.id}/keys`, { id: anaAgent.id }, { scopes: ['team.manage'] });
    check('own key: nor anything neither holds', teamScope.status === 422 || teamScope.status === 403, teamScope.body);
    const benKey = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${benAgent.id}/keys`, { id: benAgent.id }, { scopes: ['tasks.read'] });
    check('own key: someone else\'s personal agent reads as missing', benKey.status === 404, benKey.body);
    const ownDefault = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${anaAgent.id}/keys`, { id: anaAgent.id }, {});
    check('own key: by default the template\'s scopes Ana can grant, the rest named', ownDefault.status === 201 && ownDefault.body.data.left_out.includes('project_context.read')
      && ownDefault.body.data.left_out.includes('agent_activity.write') && !ownDefault.body.data.key.scopes.includes('project_context.read'), ownDefault.body);

    // ── Rotation with overlap ──────────────────────────────────────────
    const ownKeyId = own.body?.data?.key?.id as string;
    const ownSecret = own.body?.data?.secret as string;
    const rotated = await session(sessionRotate.POST, 'POST', `/api/workspace/api-keys/${ownKeyId}/rotate`, { id: ownKeyId }, { overlap_hours: 1 });
    const newSecret = rotated.body?.data?.secret as string;
    const newId = rotated.body?.data?.key?.id as string;
    const overlapEnds = new Date(rotated.body?.data?.previous?.expires_at ?? 0).getTime();
    check('rotate: Ana rotates her agent\'s key; the old one lasts the overlap', rotated.status === 201 && /^pk_live_/.test(newSecret ?? '') && newSecret !== ownSecret
      && rotated.body.data.key.rotated_from === ownKeyId && Math.abs(overlapEnds - (Date.now() + 3600_000)) < 120_000, rotated.body);
    const oldStill = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, ownSecret);
    const newWorks = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, newSecret);
    check('rotate: both keys work during the overlap', oldStill.status === 200 && newWorks.status === 200, [oldStill.status, newWorks.status]);
    const lineage = (await s.q<Loose>('SELECT name, scopes, team_member_id, created_by_key_id, rotated_from FROM pm.api_keys WHERE id = $1', [newId]))[0];
    check('rotate: same member, scopes and name, lineage recorded', lineage.name === 'My laptop' && JSON.stringify(lineage.scopes) === JSON.stringify(['tasks.read', 'projects.read'])
      && lineage.team_member_id === anaAgent.id && lineage.rotated_from === ownKeyId, lineage);
    const twiceRotated = await session(sessionRotate.POST, 'POST', `/api/workspace/api-keys/${ownKeyId}/rotate`, { id: ownKeyId }, {});
    check('rotate: a key is replaced once', twiceRotated.status === 409 && reason(twiceRotated) === 'not_rotatable', twiceRotated.body);
    as(LOGINS.ben);
    const benRotatesAna = await session(sessionRotate.POST, 'POST', `/api/workspace/api-keys/${newId}/rotate`, { id: newId }, {});
    check('rotate: someone else cannot rotate her agent\'s key', benRotatesAna.status === 403, benRotatesAna.body);
    as(LOGINS.ana);
    // The window passes.
    await s.q("UPDATE pm.api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [ownKeyId]);
    const expired = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, ownSecret);
    check('expiry: a key past its time is 401 api_key_expired', expired.status === 401 && reason(expired) === 'api_key_expired', expired.body);
    const swept = (await s.q<{ n: number }>('SELECT pm.revoke_rotated_api_keys() AS n'))[0].n;
    const afterSweep = (await s.q<Loose>('SELECT revoked_at FROM pm.api_keys WHERE id = $1', [ownKeyId]))[0];
    check('rotate: once the window ends the old key is revoked, with an audit row; the new one lives', swept === 1 && afterSweep.revoked_at !== null
      && await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_id = $1 AND endpoint LIKE '%/rotation-ended'", [ownKeyId]) === 1
      && (await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, newSecret)).status === 200, { swept, afterSweep });
    as(LOGINS.owner);
    const harnessRotate = await v1(v1Rotate.POST, 'POST', `/api/v1/api-keys/${anaKeyId}/rotate`, { id: anaKeyId }, s.keys.harness.secret, {});
    const anaKey2 = harnessRotate.body?.data?.secret as string;
    const anaKey2Id = harnessRotate.body?.data?.key?.id as string;
    check('rotate: the harness rotates a personal agent\'s key, keeping its place under the harness key', harnessRotate.status === 201
      && (await s.q<Loose>('SELECT created_by_key_id FROM pm.api_keys WHERE id = $1', [anaKey2Id]))[0]?.created_by_key_id === s.keys.harness.id, harnessRotate.body);
    const harnessJeff = await v1(v1Rotate.POST, 'POST', `/api/v1/api-keys/${s.keys.jeff.id}/rotate`, { id: s.keys.jeff.id }, s.keys.harness.secret, {});
    check('rotate: the harness never rotates a shared agent\'s key', harnessJeff.status === 403, harnessJeff.body);
    const mcpRotate = await runTool(s.keys.harness.secret, s.owner, 'rotate_api_key', { key_id: anaKey2Id, overlap_hours: 0 });
    check('rotate: rotate_api_key over MCP, the old key ending at once with overlap 0', mcpRotate?.ok === true && /^pk_live_/.test(mcpRotate.data?.secret ?? '')
      && (await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey2)).status === 401, mcpRotate);
    const anaKey3 = mcpRotate?.data?.secret as string;

    // ── Key lifetime ────────────────────────────────────────────────────
    as(LOGINS.ana);
    const anaLifetime = await session(keySettings.PATCH, 'PATCH', '/api/workspace/key-settings', {}, { agent_key_lifetime_days: 30 });
    check('lifetime: only an Owner sets it', anaLifetime.status === 403, anaLifetime.body);
    as(LOGINS.owner);
    const lifetime = await session(keySettings.PATCH, 'PATCH', '/api/workspace/key-settings', {}, { agent_key_lifetime_days: 30 });
    check('lifetime: an Owner sets 30 days', lifetime.status === 200 && lifetime.body.data.agent_key_lifetime_days === 30, lifetime.body);
    await s.q('UPDATE pm.api_keys SET revoked_at = now() WHERE team_member_id = $1 AND revoked_at IS NULL', [benAgent.id]);
    const benClaim = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${benAgent.id}/key`, { id: benAgent.id }, s.keys.harness.secret, {});
    const benExpires = new Date(benClaim.body?.data?.key?.expires_at ?? 0).getTime();
    check('lifetime: a new agent key lasts it', benClaim.status === 201 && Math.abs(benExpires - (Date.now() + 30 * 86_400_000)) < 120_000, benClaim.body);
    const anaOwnKey = (await s.q<Loose>('SELECT expires_at FROM pm.api_keys WHERE id = $1', [s.keys.anaOwn.id]))[0];
    check('lifetime: a person\'s own key never gets one', anaOwnKey.expires_at === null);
    await jeffWorks('after the lifetime is set');
    await session(keySettings.PATCH, 'PATCH', '/api/workspace/key-settings', {}, { agent_key_lifetime_days: null });

    // ── Auto-provision on join ─────────────────────────────────────────
    const invited = await sessionNext(inviteRoute.POST, '/api/team-members/invite', { name: 'Cara Diaz', email: 'cara@example.com', role: 'member' });
    const cara = invited.body?.id as string;
    check('join: a new member gets their personal agent at once', invited.status === 201 && invited.body.assistants?.length === 1
      && (await s.q<Loose>('SELECT name, delegate_of FROM pm.team_members WHERE id = $1', [invited.body.assistants?.[0]?.id]))[0]?.delegate_of === cara, invited.body);
    const guest = await sessionNext(inviteRoute.POST, '/api/team-members/invite', { name: 'Gus', email: 'gus@example.com', role: 'guest' });
    check('join: a role with no setup gets none', guest.status === 201 && guest.body.assistants?.length === 0, guest.body);
    await session(setupRoute.PATCH, 'PATCH', `/api/workspace/assistants/setups/${setupId}`, { id: setupId }, { enabled: false });
    const off = await sessionNext(inviteRoute.POST, '/api/team-members/invite', { name: 'Dee', email: 'dee@example.com', role: 'member' });
    check('join: a setup that is off makes none', off.status === 201 && off.body.assistants?.length === 0, off.body);
    await session(setupRoute.PATCH, 'PATCH', `/api/workspace/assistants/setups/${setupId}`, { id: setupId }, { enabled: true });

    // A group's setup: Gus (a guest, whose role has none) is in Contractors.
    const gus = guest.body?.id as string;
    const contractors = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Contractors', 'contractors') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [contractors, gus]);
    const groupSetup = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_group_id: contractors, settings: { name_template: '{name} helper' } });
    const groupDry = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, { dry_run: true, setup_id: groupSetup.body?.data?.id });
    check('groups: a group setup matches its members whatever their role', groupSetup.status === 201 && groupDry.body?.data?.agents?.map((a: Loose) => a.person.id).join() === gus, groupDry.body);
    const groupRun = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, {});
    const gusAgent = (await s.q<Loose>('SELECT name FROM pm.team_members WHERE delegate_of = $1', [gus]))[0];
    check('groups: provisioning makes it, named by the group\'s setup; one setup per person and template', groupRun.status === 200 && gusAgent?.name === 'Gus helper'
      && await count('SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of = $1', [gus]) === 1, { body: groupRun.body?.data?.agents, gusAgent });

    // ── A rotated harness key still takes down what it collected ──────
    const hSecret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const hId = (await s.q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Harness H', 'pk_live', $1, $2, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update(hSecret).digest('hex'), s.owner, ['assistants.provision', ...s.TEMPLATE_SCOPES]]))[0].id;
    const collected: string[] = [];
    for (const person of [cara, gus]) {
      const agentId = (await s.q<{ id: string }>('SELECT id FROM pm.team_members WHERE delegate_of = $1', [person]))[0].id;
      const got = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${agentId}/key`, { id: agentId }, hSecret, {});
      if (got.body?.data?.key?.id) collected.push(got.body.data.key.id);
    }
    const hRotated = await session(sessionRotate.POST, 'POST', `/api/workspace/api-keys/${hId}/rotate`, { id: hId }, { overlap_hours: 1 });
    const hNextId = hRotated.body?.data?.key?.id as string;
    await s.q("UPDATE pm.api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [hId]);
    await s.q('SELECT pm.revoke_rotated_api_keys()');
    const liveCollected = async () => count('SELECT count(*)::int AS n FROM pm.api_keys WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL', [collected]);
    check('lineage: H collects two keys, rotates to H\', and its overlap ends with the collected keys still live', collected.length === 2 && hRotated.status === 201
      && (await s.q<Loose>('SELECT revoked_at FROM pm.api_keys WHERE id = $1', [hId]))[0].revoked_at !== null && await liveCollected() === 2, { collected, rotated: hRotated.body });
    const hRevoke = await v1(v1Revoke.POST, 'POST', `/api/v1/api-keys/${hNextId}/revoke`, { id: hNextId }, s.keys.owner.secret);
    check('lineage: revoking H\' revokes every key H collected', hRevoke.status === 200 && await liveCollected() === 0
      && collected.every((id) => (hRevoke.body?.data?.cascaded_revokes ?? []).includes(id)), hRevoke.body);

    // ── Bind ───────────────────────────────────────────────────────────
    as(LOGINS.ana);
    const anaBind = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.helper, person_id: s.ana });
    check('bind: only an Owner changes who an agent works for', anaBind.status === 403, anaBind.body);
    as(LOGINS.owner);
    const toAgent = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.helper, person_id: s.jeff });
    check('bind: never to an agent', toAgent.status === 422 && reason(toAgent) === 'person_is_agent', toAgent.body);
    // A shared agent with a login becomes Ana's: it may no longer sign in.
    const helperLogin = randomUUID();
    await s.q("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, 'helper@example.com', now())", [helperLogin]);
    await s.q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [helperLogin, s.helper]);
    const helperLink = await issueInvite(service, { memberId: s.helper, createdBy: s.owner, appUrl: 'https://pm.example.com' });
    const helperToken = new URL(helperLink).searchParams.get('token');
    check('sign-in: a shared agent\'s set-password link works before it is bound', (await peekInvite(service, helperToken)).name === 'Helper');
    const toAna = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.helper, person_id: s.ana });
    check('bind: an Owner makes a shared agent Ana\'s', toAna.status === 200 && toAna.body.data.agent.delegate_of === s.ana
      && await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE agent_id = $1 AND member_id = $2', [s.helper, s.ana]) === 1, toAna.body);
    check('sign-in: a personal agent\'s set-password link stops working', await peekInvite(service, helperToken).then(() => false, (e: Error) => /expired/.test(e.message)));
    const relink = await sessionNext(((req: NextRequest) => reissueRoute.POST(req, { params: Promise.resolve({ id: s.helper }) } as never)) as (r: NextRequest) => Promise<Response>,
      `/api/team-members/${s.helper}/invite`, { send: false });
    check('sign-in: no invite link is made for a personal agent, saying why', relink.status === 422 && /never signs in/.test(relink.body?.error ?? ''), relink.body);
    check('sign-in: the Team page offers no invite for a personal agent', !canHaveSignIn({ delegate_of: s.ana }) && canHaveSignIn({ delegate_of: null }) && canHaveSignIn({}));
    // Re-binding or unbinding ends everything made for the person before.
    as(LOGINS.ana);
    const helperKeyAna = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${s.helper}/keys`, { id: s.helper }, { scopes: ['tasks.read', 'projects.read'] });
    const anaHelperSecret = helperKeyAna.body?.data?.secret as string;
    check('rebind: Ana\'s key for her new agent reads her projects', helperKeyAna.status === 201
      && JSON.stringify(projectIds(await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaHelperSecret))) === JSON.stringify([s.anaOnly, s.shared].sort()), helperKeyAna.body);
    as(LOGINS.owner);
    const helperToken2 = (await s.q<{ id: string }>(`INSERT INTO pm.delegation_tokens (token_hash, agent_id, principal_id, minted_via, expires_at)
      VALUES ('hash-helper-token', $1, $2, 'session', now() + interval '15 minutes') RETURNING id`, [s.helper, s.ana]))[0].id;
    const toBen = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.helper, person_id: s.ben });
    const afterRebind = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaHelperSecret);
    check('rebind: re-binding to Ben revokes the key Ana made: it never reads Ben\'s data', toBen.status === 200 && afterRebind.status === 401
      && await count('SELECT count(*)::int AS n FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [s.helper]) === 0, afterRebind.body);
    check('rebind: and the tokens it held, and Ana\'s ownership, audited', (await s.q<Loose>('SELECT revoked_at FROM pm.delegation_tokens WHERE id = $1', [helperToken2]))[0].revoked_at !== null
      && await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE agent_id = $1 AND member_id = $2', [s.helper, s.ana]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint = $1', [`/app/team-members/${s.helper}/rebind`]) >= 2);
    as(LOGINS.ben);
    const helperKeyBen = await session(ownKeyRoute.POST, 'POST', `/api/workspace/assistants/${s.helper}/keys`, { id: s.helper }, { scopes: ['tasks.read', 'projects.read'] });
    const benHelperSecret = helperKeyBen.body?.data?.secret as string;
    as(LOGINS.owner);
    const unbind = await session(bindRoute.POST, 'POST', '/api/workspace/assistants/bind', {}, { agent_id: s.helper, person_id: null });
    const afterUnbind = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, benHelperSecret);
    check('rebind: unbinding revokes the key Ben made, so it never reads as a shared agent', helperKeyBen.status === 201 && unbind.status === 200
      && unbind.body.data.agent.delegate_of === null && afterUnbind.status === 401, { mint: helperKeyBen.body, unbind: unbind.body, after: afterUnbind.body });
    // Helper stays shared; Ana owns it by name, so the cascade has an owner to remove.
    await s.q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [s.helper, s.ana]);

    // ── Deprovision cascade ────────────────────────────────────────────
    // A key made by her agent's key, a shared agent's token for her, one her agent holds, and a pending link.
    const child = (await s.q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, created_by_key_id, scopes, permissions)
      VALUES ('Child', 'pk_live', 'hash-child', $1, $2, $3, '{tasks.read}', 'scoped') RETURNING id`, [anaAgent.id, s.owner, newId]))[0].id;
    const sharedToken = (await s.q<{ id: string }>(`INSERT INTO pm.delegation_tokens (token_hash, agent_id, principal_id, minted_via, expires_at)
      VALUES ('hash-shared-token', $1, $2, 'session', now() + interval '15 minutes') RETURNING id`, [s.helper, s.ana]))[0].id;
    const link = (await s.q<{ id: string }>(`INSERT INTO pm.identity_link_requests (token_hash, provider, external_id, expected_member_id, expires_at)
      VALUES ('hash-link', 'slack', 'U-ANA', $1, now() + interval '1 day') RETURNING id`, [s.ana]))[0].id;
    const liveBefore = (await s.q<{ id: string }>('SELECT id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [anaAgent.id])).map((r) => r.id);
    const suspended = await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.ana}`, { id: s.ana }, { status: 'suspended' });
    const agentAfter = (await s.q<Loose>('SELECT status, delegate_paused_at FROM pm.team_members WHERE id = $1', [anaAgent.id]))[0];
    check('deprovision: suspending Ana pauses her personal agent', suspended.status === 200 && agentAfter.status === 'suspended' && agentAfter.delegate_paused_at !== null, { body: suspended.body, agentAfter });
    check('deprovision: every key of hers revoked, with the keys they made', liveBefore.length >= 3 && liveBefore.includes(child)
      && await count('SELECT count(*)::int AS n FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [anaAgent.id]) === 0, liveBefore);
    check('deprovision: delegation tokens naming her, or held by her agent, revoked', (await s.q<Loose>('SELECT revoked_at FROM pm.delegation_tokens WHERE id = $1', [sharedToken]))[0].revoked_at !== null
      && await count('SELECT count(*)::int AS n FROM pm.delegation_tokens WHERE agent_id = $1 AND revoked_at IS NULL', [anaAgent.id]) === 0);
    check('deprovision: her pending link request stops working', new Date((await s.q<Loose>('SELECT expires_at FROM pm.identity_link_requests WHERE id = $1', [link]))[0].expires_at).getTime() <= Date.now() + 1000);
    check('deprovision: she owns no agent; the shared one falls back to the Owner', await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE member_id = $1', [s.ana]) === 0
      && await escalationTarget(service, s.helper) === s.owner);
    const steps = (await s.q<Loose>(`SELECT DISTINCT request_body->>'step' AS step FROM pm.api_audit_log WHERE endpoint = $1`, [`/app/team-members/${s.ana}/deprovision`])).map((r: Loose) => r.step).sort();
    check('deprovision: every step audited', JSON.stringify(steps) === JSON.stringify(['agent_paused', 'delegations_revoked', 'identity_links_expired', 'key_revoked', 'owner_removed']), steps);
    const deadKey = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey3);
    check('deprovision: her agent\'s key is dead', deadKey.status === 401, deadKey.body);
    await jeffWorks('after a deprovision');

    // Ben's agent paused by hand first: his suspension and return leave it paused.
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [benAgent.id]);
    await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.ben}`, { id: s.ben }, { status: 'suspended' });
    await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.ben}`, { id: s.ben }, { status: 'active' });
    check('reactivate: an agent paused by hand stays paused', (await s.q<Loose>('SELECT status, delegate_paused_at FROM pm.team_members WHERE id = $1', [benAgent.id]))[0].status === 'suspended');

    // ── Reactivation ───────────────────────────────────────────────────
    const back = await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.ana}`, { id: s.ana }, { status: 'active' });
    const resumed = (await s.q<Loose>('SELECT status, delegate_paused_at FROM pm.team_members WHERE id = $1', [anaAgent.id]))[0];
    check('reactivate: un-pauses what the cascade paused and gives back the ownership it took', back.status === 200 && resumed.status === 'active' && resumed.delegate_paused_at === null
      && await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE agent_id = $1 AND member_id = $2', [s.helper, s.ana]) === 1
      && await count('SELECT count(*)::int AS n FROM pm.agent_owners WHERE agent_id = $1 AND member_id = $2', [anaAgent.id, s.ana]) === 1, resumed);
    check('reactivate: never restores a key', await count('SELECT count(*)::int AS n FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [anaAgent.id]) === 0
      && (await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, anaKey3)).status === 401);
    check('reactivate: audited', await count('SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint = $1', [`/app/team-members/${s.ana}/reactivate`]) === 2);
    const fresh = await v1(v1Claim.POST, 'POST', `/api/v1/assistants/${anaAgent.id}/key`, { id: anaAgent.id }, s.keys.harness.secret, {});
    check('reactivate: a new key is collected the usual way', fresh.status === 201, fresh.body);

    // Revoking the harness key revokes every key it collected.
    const harnessRevoke = await v1(v1Revoke.POST, 'POST', `/api/v1/api-keys/${s.keys.harness.id}/revoke`, { id: s.keys.harness.id }, s.keys.owner.secret);
    check('harness: revoking its key revokes every key it collected', harnessRevoke.status === 200
      && await count('SELECT count(*)::int AS n FROM pm.api_keys k JOIN pm.team_members m ON m.id = k.team_member_id WHERE m.delegate_of IS NOT NULL AND k.revoked_at IS NULL AND k.created_by_key_id IS NOT NULL') === 0, harnessRevoke.body);
    await jeffWorks('at the end of the keys');

    // ── Webhook secrets ────────────────────────────────────────────────
    const receiver: { body: string; signature: string | null }[] = [];
    const hookServer = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => { receiver.push({ body: raw, signature: (request.headers['x-vm-signature'] as string) ?? null }); response.writeHead(200); response.end('ok'); });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hook`;
    const deliveries: { endpoint: string; error: string | null }[] = [];
    const storeFor = (endpointId: string, stored: string): DispatchStore => {
      let given = false;
      return {
        async claim() {
          if (given) return [];
          given = true;
          return [{ delivery_id: randomUUID(), attempt_token: randomUUID(), attempts: 0, endpoint_id: endpointId, endpoint_url: hookUrl, endpoint_secret: stored,
            event_public_id: 'evt_1', event_type: 'task.created', event_sequence: 1, resource_id: null, payload: { hello: 'world' } } satisfies ClaimedDelivery];
        },
        async complete(d, result) { deliveries.push({ endpoint: d.endpoint_id, error: result.error }); return result.error ? 'retrying' : 'succeeded'; },
      };
    };
    const signedWith = async (secret: string) => {
      const last = receiver[receiver.length - 1];
      return !!last && verifySignatureHeader(secret, last.signature, last.body);
    };
    const hookBody = { name: 'Harness', url: 'https://hooks.example.test/h', events: ['task.created'] };
    // Without APP_ENCRYPTION_KEY: exactly as before.
    const plain = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, hookBody);
    const plainId = plain.body?.data?.endpoint?.id as string;
    const plainSecret = plain.body?.data?.secret as string;
    const plainStored = (await s.q<Loose>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [plainId]))[0]?.secret;
    check('webhooks: without the key the secret is stored as before', plain.status === 201 && plainStored === plainSecret, plain.body);
    await runDispatch(5, storeFor(plainId, plainStored));
    check('webhooks: and signs as before', await signedWith(plainSecret) && deliveries[deliveries.length - 1]?.error === null, deliveries);
    const status = await encryptionStatus(service);
    check('webhooks: the Encryption setup counts it', status.appKey === 'missing' && status.remaining.webhooks >= 1, status);
    // With the key.
    process.env.APP_ENCRYPTION_KEY = APP_KEY;
    const sealedHook = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, { ...hookBody, name: 'Sealed' });
    const sealedId = sealedHook.body?.data?.endpoint?.id as string;
    const sealedSecret = sealedHook.body?.data?.secret as string;
    const sealedStored = (await s.q<Loose>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [sealedId]))[0]?.secret as string;
    check('webhooks: with the key the secret is sealed at rest, the answer still shows it once', sealedHook.status === 201 && /^whsec_/.test(sealedSecret ?? '')
      && sealedStored?.startsWith('pm1:') && !sealedStored.includes(sealedSecret), { sealedStored, sealedSecret });
    check('webhooks: the API never shows a stored secret', !JSON.stringify(sealedHook.body.data.endpoint).includes('pm1:'));
    await runDispatch(5, storeFor(sealedId, sealedStored));
    check('webhooks: the dispatcher opens it and signing still verifies', await signedWith(sealedSecret) && deliveries[deliveries.length - 1]?.error === null, deliveries.slice(-1));
    const revealed = await session(secretRoute.GET, 'GET', `/api/workspace/webhook-endpoints/${sealedId}/secret`, { id: sealedId });
    check('webhooks: Settings reveals it through the server', revealed.status === 200 && revealed.body.data.secret === sealedSecret && revealed.headers.get('cache-control') === 'no-store', revealed.body);
    as(LOGINS.ana);
    const anaReveal = await session(secretRoute.GET, 'GET', `/api/workspace/webhook-endpoints/${sealedId}/secret`, { id: sealedId });
    check('webhooks: never to someone without Manage webhooks', anaReveal.status === 403, anaReveal.body);
    as(LOGINS.owner);
    // A plaintext secret signs with the key set and stays plaintext (rollback safety): only the re-encrypt moves it.
    await runDispatch(5, storeFor(plainId, plainStored));
    const kept = (await s.q<Loose>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [plainId]))[0].secret as string;
    check('webhooks: a plaintext secret stays plaintext after a delivery with the key set, and still signs', kept === plainSecret
      && await signedWith(plainSecret) && deliveries[deliveries.length - 1]?.error === null, kept);
    const dispatchSource = readFileSync(join(__dirname, '..', 'src', 'lib', 'webhooks', 'dispatch.ts'), 'utf8');
    check('webhooks: the dispatcher never writes a secret (this release rolls back cleanly)', !/from\('webhook_endpoints'\)\s*\.update/.test(dispatchSource) && !/reseal/.test(dispatchSource));
    // The key changed: the delivery waits, saying why.
    process.env.APP_ENCRYPTION_KEY = OTHER_KEY;
    await runDispatch(5, storeFor(sealedId, sealedStored));
    check('webhooks: with another key the delivery fails to retry, saying why', deliveries[deliveries.length - 1]?.error === SEALED_SECRET_UNREADABLE, deliveries.slice(-1));
    process.env.APP_ENCRYPTION_KEY = APP_KEY;
    await s.q("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Browser made', 'https://hooks.example.test/b', 'whsec_browser', '{task.created}')");
    const before = await encryptionStatus(service);
    const reencrypted = await reencryptAll(service);
    check('webhooks: Settings > Encryption moves plaintext secrets and counts none left', before.remaining.webhooks === 2 && reencrypted.moved.webhooks === 2
      && reencrypted.status.remaining.webhooks === 0 && await count("SELECT count(*)::int AS n FROM pm.webhook_endpoints WHERE secret NOT LIKE 'pm1:%'") === 0, { before: before.remaining, reencrypted });
    hookServer.close();
    delete process.env.APP_ENCRYPTION_KEY;

    // ── MCP ────────────────────────────────────────────────────────────
    const harness2 = (await s.q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Harness 2', 'pk_live', $1, $2, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update('pk_live_harness2').digest('hex'), s.owner, ['assistants.provision', ...s.TEMPLATE_SCOPES]]))[0].id;
    void harness2;
    const mcpList = await runTool('pk_live_harness2', s.owner, 'list_assistants', { needs_key: true });
    check('MCP: list_assistants with needs_key', mcpList?.ok === true && Array.isArray(mcpList.data), mcpList);
    const mcpDry = await runTool('pk_live_harness2', s.owner, 'provision_assistants', { dry_run: true });
    check('MCP: provision_assistants dry run', mcpDry?.ok === true && mcpDry.data?.dry_run === true && typeof mcpDry.data.total_missing === 'number', mcpDry);
    const mcpSetups = await runTool('pk_live_harness2', s.owner, 'list_assistant_setups', {});
    check('MCP: list_assistant_setups', mcpSetups?.ok === true && mcpSetups.data?.length === 2, mcpSetups);

    // ── Scale: 500 members ─────────────────────────────────────────────
    await s.q(`INSERT INTO pm.team_members (name, email, role) SELECT 'Person ' || g, 'person' || g || '@example.com', 'member' FROM generate_series(1, 500) g`);
    const started = Date.now();
    const scaleDry = await v1(v1Provision.POST, 'POST', '/api/v1/assistants/provision', {}, 'pk_live_harness2', { dry_run: true, limit: 500 });
    const total = scaleDry.body?.data?.total_missing as number;
    const pages: Loose[] = [];
    for (let i = 0; i < 5; i++) {
      const page = await v1(v1Provision.POST, 'POST', '/api/v1/assistants/provision', {}, 'pk_live_harness2', { limit: 250 });
      pages.push(page.body?.data);
      if (page.body?.data?.remaining === 0) break;
    }
    const last = await v1(v1Provision.POST, 'POST', '/api/v1/assistants/provision', {}, 'pk_live_harness2', { limit: 250 });
    const took = Date.now() - started;
    check('scale: a dry run names all 500 in one page', scaleDry.status === 200 && scaleDry.body.data.total_missing >= 500 && scaleDry.body.data.agents.length >= 500, scaleDry.body?.data?.total_missing);
    check('scale: pages of 250 people make them all, then nothing is left to do', pages.length === Math.ceil(total / 250)
      && pages[0]?.agents?.filter((a: Loose) => a.agent_id).length === 250 && pages[pages.length - 1]?.remaining === 0
      && last.body?.data?.agents?.length === 0 && last.body.data.total_missing === 0, { total, pages: pages.map((p) => [p?.agents?.length, p?.remaining]), last: last.body?.data?.total_missing });
    check('scale: one personal agent each, no more', await count("SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of IN (SELECT id FROM pm.team_members WHERE name LIKE 'Person %')") === 500
      && await count('SELECT count(*)::int AS n FROM (SELECT delegate_of FROM pm.team_members WHERE delegate_of IS NOT NULL GROUP BY delegate_of, assistant_template HAVING count(*) > 1) d') === 0);
    check('scale: within a minute on PGlite', took < 60_000, took);
    const scaleList = await v1(v1Assistants.GET, 'GET', '/api/v1/assistants?needs_key=true&limit=100', {}, 'pk_live_harness2');
    check('scale: needs_key pages over hundreds', scaleList.status === 200 && scaleList.body.data.length === 100 && scaleList.body.meta.total >= 500, scaleList.body?.meta);
    await jeffWorks('at the end');
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
