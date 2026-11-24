/**
 * Identity, groups and on behalf of, end to end over the real routes
 * (session routes with a signed-in member, v1 routes with keys, MCP tools
 * through routeCaller, a fake PostgREST over PGlite with the full schema):
 * - The migration (20261124000900_identity_groups_principal.sql), run twice
 *   on the schema before it, matches schema.sql; the previous release's
 *   question inserts (always asked_to) still work; exactly one of asked_to
 *   and asked_to_group is required; principal_id comes only from the
 *   server's header, never from a row or a signed-in member.
 * - Groups: create, read, edit, Trash, members (lead first), refused without
 *   groups.manage; readers see every group, a guest only their own.
 * - A question asked to a group: every active member's bell rings (never the
 *   asker's), any member answers (answered_by says who), every bell clears,
 *   a non-member is refused and cannot see it; approvals only for people.
 * - Escalation through a group, and groups that own agents (only people in
 *   them, never an agent, and an agent never rewrites its own owners); the
 *   owner-group row policy reads only the reader's own groups.
 * - Linked identities: the link handshake (single use, expiry, wrong member,
 *   replay, linked elsewhere), only verified identities resolve, admin
 *   linking in bulk, admin unlink and move, lookups and their scopes, a
 *   member's own list.
 * - Delegation: minting rules, a token bound to one agent, expiry and
 *   revocation, the intersection of agent and person (a project the agent
 *   reaches but its principal does not is out of reach), principal_id on
 *   run, question, task, comment and audit, MCP carrying the token, and no
 *   token meaning no change; acting for a person never reads the agent's
 *   own questions, runs, reminders or bell outside that person's reach.
 * - Scale: 500 members and 50 groups read paged in a fixed number of rows.
 *
 *   npm run -s test:identity-groups
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { intersectAccess, type AccessContext } from '../src/lib/access-control';
import { groupTargetLabel, slugifyGroupName } from '../src/lib/groups';
import { IDENTITY_PROVIDER_PATTERN, normalizeExternalId, providerLabel } from '../src/lib/identities';

const MIGRATION = '20261124000900_identity_groups_principal.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- IDENTITY, GROUPS AND ON BEHALF OF (20261124000900_identity_groups_principal.sql)';

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
  owner: { id: '00000000-0000-4000-8000-00000000b001', email: 'olivia@example.com' },
  morgan: { id: '00000000-0000-4000-8000-00000000b002', email: 'morgan@example.com' },
  mia: { id: '00000000-0000-4000-8000-00000000b003', email: 'mia@example.com' },
  nina: { id: '00000000-0000-4000-8000-00000000b004', email: 'nina@example.com' },
  guest: { id: '00000000-0000-4000-8000-00000000b005', email: 'gus@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
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
  const agent: AccessContext = { member_id: 'a', role: 'agent', status: 'active', app_permissions: [], api_permissions: ['projects.read', 'tasks.read', 'tasks.create', 'agent_activity.write'], project_ids: ['p1', 'p2'] };
  const person: AccessContext = { member_id: 'm', role: 'member', status: 'active', app_permissions: ['team.read'], api_permissions: ['projects.read', 'tasks.read', 'reminders.manage_own'], project_ids: ['p2', 'p3'] };
  const both = intersectAccess(agent, person);
  check('intersect: permissions both hold, and nothing either lacks', JSON.stringify(both.api_permissions) === JSON.stringify(['projects.read', 'tasks.read']), both.api_permissions);
  check('intersect: only projects both reach', JSON.stringify(both.project_ids) === JSON.stringify(['p2']), both.project_ids);
  check('intersect: stays the agent, naming the person', both.member_id === 'a' && both.role === 'agent' && both.principal_id === 'm');
  const owner: AccessContext = { member_id: 'o', role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
  const forOwner = intersectAccess(agent, owner);
  check('intersect: an Owner principal leaves the agent as it is', JSON.stringify(forOwner.api_permissions) === JSON.stringify(agent.api_permissions)
    && JSON.stringify(forOwner.project_ids) === JSON.stringify(['p1', 'p2']), forOwner);
  const wide: AccessContext = { ...agent, api_permissions: ['projects.read_all', 'tasks.read'], project_ids: [] };
  const narrowed = intersectAccess(wide, person);
  check('intersect: an agent that reads every project reaches only the person\'s', JSON.stringify(narrowed.project_ids) === JSON.stringify(['p2', 'p3'])
    && narrowed.api_permissions.includes('projects.read') && !narrowed.api_permissions.includes('projects.read_all'), narrowed);
  check('intersect: a suspended person suspends it', intersectAccess(agent, { ...person, status: 'suspended' }).status === 'suspended');
  const appOnly: AccessContext = { ...agent, app_permissions: ['projects.read_all'], api_permissions: ['projects.read', 'tasks.read'], project_ids: ['p1'] };
  const fromApp = intersectAccess(appOnly, { ...person, project_ids: ['p2'] });
  check('intersect: read_all on the app channel alone never widens API reach', !fromApp.project_ids.includes('p2') && fromApp.project_ids.length === 0, fromApp.project_ids);
  check('slugs: from names', slugifyGroupName('Finance & Ops') === 'finance-ops' && slugifyGroupName('  Café Team ') === 'cafe-team' && slugifyGroupName('!!') === '');
  check('identities: providers by pattern', ['slack', 'teams', 'telegram', 'custom.mattermost'].every((p) => IDENTITY_PROVIDER_PATTERN.test(p))
    && !IDENTITY_PROVIDER_PATTERN.test('Slack') && !IDENTITY_PROVIDER_PATTERN.test('custom.') && !IDENTITY_PROVIDER_PATTERN.test('irc'));
  check('identities: email compares without case; ids keep theirs', normalizeExternalId('email', ' Maria@Acme.COM ') === 'maria@acme.com' && normalizeExternalId('slack', 'U0ABC') === 'U0ABC');
  check('labels', providerLabel('custom.mattermost') === 'Mattermost' && providerLabel('teams') === 'Microsoft Teams' && groupTargetLabel('Finance') === 'Finance (any member)');
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the identity and groups section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Groups')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const asker = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Bot', 'bot@example.com', 'agent') RETURNING id"))[0].id;
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const before = (await q<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Before?') RETURNING id", [asker, person]))[0].id;

  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const kept = (await q<Loose>('SELECT asked_to, asked_to_group, principal_id FROM pm.questions WHERE id = $1', [before]))[0];
  check('upgrade: an existing question keeps its member and gets no group or principal', kept.asked_to === person && kept.asked_to_group === null && kept.principal_id === null, kept);
  // What 2.0.21 writes: asked_to always, nothing new.
  const old21 = (await q<Loose>("INSERT INTO pm.questions (asked_by, asked_to, question, choices) VALUES ($1, $2, 'Ship it?', '[\"Yes\",\"No\"]') RETURNING asked_to, asked_to_group, principal_id", [asker, person]))[0];
  check('upgrade: a 2.0.21-shaped question insert still works', old21.asked_to === person && old21.asked_to_group === null && old21.principal_id === null, old21);
  const fail = (db: PGlite, sql: string, params: unknown[] = []) => db.query(sql, params).then(() => null, (e: Error) => e.message);
  check('database: a question names someone to ask', /questions_one_addressee/.test(await fail(old, "INSERT INTO pm.questions (asked_by, question) VALUES ($1, 'Nobody?')", [asker]) ?? ''));
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Finance', 'finance') RETURNING id"))[0].id;
  check('database: never both a member and a group', /questions_one_addressee/.test(await fail(old, "INSERT INTO pm.questions (asked_by, asked_to, asked_to_group, question) VALUES ($1, $2, $3, 'Both?')", [asker, person, group]) ?? ''));
  check('database: a slug is taken once among live groups', /groups_slug_live/.test(await fail(old, "INSERT INTO pm.groups (name, slug) VALUES ('Finance 2', 'finance')") ?? ''));
  await q('UPDATE pm.groups SET deleted_at = now() WHERE id = $1', [group]);
  check('database: a slug comes free when its group goes to Trash', (await fail(old, "INSERT INTO pm.groups (name, slug) VALUES ('Finance', 'finance')")) === null);
  check('database: a group is never permanently deleted', (await fail(old, 'DELETE FROM pm.groups WHERE id = $1', [group])) !== null);
  check('database: providers are checked by shape', /member_identities_provider_shape/.test(await fail(old, "INSERT INTO pm.member_identities (member_id, provider, external_id) VALUES ($1, 'IRC', 'x')", [person]) ?? ''));
  await q("INSERT INTO pm.member_identities (member_id, provider, external_id) VALUES ($1, 'slack', 'U1')", [person]);
  check('database: one member per identity, a missing workspace counting as one', /member_identities_key/.test(await fail(old, "INSERT INTO pm.member_identities (member_id, provider, external_id) VALUES ($1, 'slack', 'U1')", [asker]) ?? '')
    && (await fail(old, "INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id) VALUES ($1, 'slack', 'U1', 'T9')", [asker])) === null);
  check('database: verified_at and verified_method go together', /member_identities_verified_together/.test(await fail(old, "INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at) VALUES ($1, 'telegram', '42', now())", [person]) ?? ''));

  // principal_id: only from the server's header, never from a row or a signed-in member.
  await old.exec("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
  await old.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-principal-id': person })]);
  const stamped = (await q<Loose>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'For Pat') RETURNING principal_id", [asker, person]))[0];
  check('stamp: the server\'s header names the principal', stamped.principal_id === person, stamped);
  await old.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-principal-id': randomUUID() })]);
  const unknown = (await q<Loose>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ghost') RETURNING principal_id", [asker, person]))[0];
  check('stamp: an unknown member in the header names no one', unknown.principal_id === null, unknown);
  await old.exec("SELECT set_config('request.headers', '', false)");
  const fixed = (await q<Loose>('UPDATE pm.questions SET principal_id = $1 WHERE id = $2 RETURNING principal_id', [asker, before]))[0];
  check('stamp: principal_id never changes once written', fixed.principal_id === null, fixed);
  await old.exec("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
  const claimed = (await q<Loose>("INSERT INTO pm.questions (asked_by, asked_to, question, principal_id) VALUES ($1, $2, 'Claimed', $1) RETURNING principal_id", [asker, person]))[0];
  check('stamp: a signed-in member\'s own write acts for no one, whatever the row says', claimed.principal_id === null, claimed);
  await old.exec("SELECT set_config('request.jwt.claim.role', '', false)");
  await old.close();

  // Row policies: a member reads the owner-group rows of their own groups only.
  const login = async (email: string, name: string, role: string) => {
    const authId = randomUUID();
    await fresh.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [authId, email]);
    const id = (await fresh.query<{ id: string }>('INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, role, authId])).rows[0].id;
    // No team directory, so only the policies' own-group clauses can grant.
    await fresh.query("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.read', 'app', 'deny') ON CONFLICT DO NOTHING", [id]);
    return { id, authId };
  };
  await fresh.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  const inA = await login('ann@example.com', 'Ann', 'member');
  const inB = await login('ben@example.com', 'Ben', 'member');
  const bot = (await fresh.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Ledger', 'ledger@example.com', 'agent') RETURNING id")).rows[0].id;
  const groupA = (await fresh.query<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('A', 'a') RETURNING id")).rows[0].id;
  const groupB = (await fresh.query<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('B', 'b') RETURNING id")).rows[0].id;
  await fresh.query('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($3, $4)', [groupA, inA.id, groupB, inB.id]);
  await fresh.query('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [bot, groupA]);
  const asked = (await fresh.query<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to_group, question) VALUES ($1, $2, 'For A?') RETURNING id", [bot, groupA])).rows[0].id;
  const seen = async (authId: string) => {
    await actAs(fresh, authId);
    const read = async (sql: string) => (await fresh.query<{ n: number }>(sql)).rows[0].n;
    const result = {
      owners: await read('SELECT count(*)::int AS n FROM pm.agent_owner_groups'),
      groups: await read('SELECT count(*)::int AS n FROM pm.groups'),
      members: await read('SELECT count(*)::int AS n FROM pm.group_members'),
      questions: await read(`SELECT count(*)::int AS n FROM pm.questions WHERE id = '${asked}'`),
    };
    await actAs(fresh, null);
    await fresh.exec('RESET ROLE');
    return result;
  };
  const ann = await seen(inA.authId);
  const ben = await seen(inB.authId);
  check('policy: a member of the owning group reads its owner row, its group and its question', ann.owners === 1 && ann.groups === 1 && ann.members === 1 && ann.questions === 1, ann);
  check('policy: a member of another group reads none of them', ben.owners === 0 && ben.groups === 1 && ben.members === 1 && ben.questions === 0, ben);
  await fresh.close();
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
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const morgan = await member('Morgan', 'member', LOGINS.morgan);
  const mia = await member('Mia', 'member', LOGINS.mia);
  const nina = await member('Nina', 'member', LOGINS.nina);
  const guest = await member('Gus', 'guest', LOGINS.guest);
  const finn = await member('Finn', 'agent');
  const gale = await member('Gale', 'agent');
  const helper = await member('Helper', 'agent');
  for (const m of [morgan, mia, nina]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny'), ($1, 'projects.read_all', 'app', 'deny') ON CONFLICT DO NOTHING", [m]);
  }
  // The two shared agents may look people up, link them and act for them.
  for (const a of [finn, gale]) {
    for (const p of ['identities.link', 'identities.read', 'agents.act_for']) {
      await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [a, p]);
    }
  }
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  // Finn reaches both; Morgan only Shared.
  const shared = await project('Shared', [finn, gale, morgan, mia]);
  const secret = await project('Secret', [finn]);
  const key = async (memberId: string, scopes: string[]) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes]);
    return secretKey;
  };
  const AGENT_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write', 'reminders.manage_own', 'notifications.manage_own', 'identities.link', 'identities.read', 'agents.act_for'];
  // Helper and Gale may read the team over the API, so the agent routes are theirs to try.
  for (const a of [helper, gale]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.read', 'api', 'allow') ON CONFLICT DO NOTHING", [a]);
  }
  const keys = {
    owner: await key(owner, ['team.read', 'team.manage', 'groups.manage', 'identities.read', 'identities.link', 'agents.act_for', 'projects.read', 'tasks.read']),
    ownerReadOnly: await key(owner, ['team.read']),
    finn: await key(finn, AGENT_SCOPES),
    finnNoActFor: await key(finn, AGENT_SCOPES.filter((s) => s !== 'agents.act_for' && s !== 'identities.read')),
    gale: await key(gale, AGENT_SCOPES),
    helper: await key(helper, [...AGENT_SCOPES]),
    helperTeam: await key(helper, ['team.read']),
    galeTeam: await key(gale, ['team.read']),
    morgan: await key(morgan, ['tasks.read']),
    ownerTeam: await key(owner, ['team.manage', 'team.read']),
  };
  return { q, owner, morgan, mia, nina, guest, finn, gale, helper, shared, secret, keys };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  try {
    const groupsRoute = await import('../src/app/api/workspace/groups/route');
    const groupRoute = await import('../src/app/api/workspace/groups/[id]/route');
    const groupMembersRoute = await import('../src/app/api/workspace/groups/[id]/members/route');
    const groupMemberRoute = await import('../src/app/api/workspace/groups/[id]/members/[memberId]/route');
    const meIdentities = await import('../src/app/api/workspace/me/identities/route');
    const meIdentity = await import('../src/app/api/workspace/me/identities/[id]/route');
    const adminIdentities = await import('../src/app/api/workspace/identities/route');
    const linkRoute = await import('../src/app/api/workspace/identities/link/[token]/route');
    const sessionDelegations = await import('../src/app/api/workspace/delegations/route');
    const sessionQuestions = await import('../src/app/api/workspace/questions/route');
    const sessionAnswer = await import('../src/app/api/workspace/questions/[id]/answer/route');
    const agentRoute = await import('../src/app/api/workspace/agents/[id]/route');
    const agentsRoute = await import('../src/app/api/workspace/agents/route');
    const v1Groups = await import('../src/app/api/v1/groups/route');
    const v1Group = await import('../src/app/api/v1/groups/[id]/route');
    const v1GroupMembers = await import('../src/app/api/v1/groups/[id]/members/route');
    const v1GroupMember = await import('../src/app/api/v1/groups/[id]/members/[memberId]/route');
    const v1GroupIdentities = await import('../src/app/api/v1/groups/[id]/identities/route');
    const v1LinkRequests = await import('../src/app/api/v1/identities/link-requests/route');
    const v1Resolve = await import('../src/app/api/v1/identities/resolve/route');
    const v1Identities = await import('../src/app/api/v1/identities/route');
    const v1MemberIdentities = await import('../src/app/api/v1/members/[id]/identities/route');
    const v1Delegations = await import('../src/app/api/v1/delegations/route');
    const v1Delegation = await import('../src/app/api/v1/delegations/[id]/route');
    const v1Questions = await import('../src/app/api/v1/questions/route');
    const v1Approvals = await import('../src/app/api/v1/approvals/route');
    const v1Project = await import('../src/app/api/v1/projects/[id]/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Comments = await import('../src/app/api/v1/tasks/[id]/comments/route');
    const v1Runs = await import('../src/app/api/v1/agents/runs/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller, toolsFor } = await import('../src/lib/mcp/server');
    const { resolveApiKey } = await import('../src/lib/api/middleware');
    const { escalationRecipient, escalationTarget } = await import('../src/lib/api/agent-rules');
    const { agentsOwnedBy, isAgentOwner } = await import('../src/lib/api/agent-owners');
    const v1Agent = await import('../src/app/api/v1/agents/[id]/route');
    const adminIdentity = await import('../src/app/api/workspace/identities/[id]/route');
    const adminMove = await import('../src/app/api/workspace/identities/[id]/move/route');
    const v1Identity = await import('../src/app/api/v1/identities/[id]/route');
    const v1IdentityMove = await import('../src/app/api/v1/identities/[id]/move/route');
    const v1Reminders = await import('../src/app/api/v1/reminders/route');
    const v1Notifications = await import('../src/app/api/v1/notifications/route');
    const v1Run = await import('../src/app/api/v1/agents/runs/[id]/route');
    const v1Question = await import('../src/app/api/v1/questions/[id]/route');
    const { ACTING_FOR_CONVENTION } = await import('../src/lib/api/agent-context');
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
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, actFor?: string) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor !== undefined ? { 'x-act-for': actFor } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason ?? answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>, actFor?: string) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost', ...(actFor ? { actFor } : {}) }), { memberId }), t.write).structuredContent as Loose;
    };

    // ── Groups: create, read, edit ─────────────────────────────────────
    as(LOGINS.morgan);
    const refusedCreate = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Nope' });
    check('groups: a member without groups.manage cannot create one', refusedCreate.status === 403 && reason(refusedCreate) === 'missing_permission', refusedCreate.body);
    as(LOGINS.owner);
    const finance = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Finance', description: 'Money questions.', lead_ids: [s.morgan], member_ids: [s.mia, s.helper] });
    const financeId = finance.body?.data?.id as string;
    check('groups: created with a slug from its name, a lead and members', finance.status === 201 && finance.body.data.slug === 'finance'
      && finance.body.data.member_count === 3 && finance.body.data.lead_count === 1, finance.body);
    const dupe = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Finance!' });
    check('groups: a taken slug is 409 slug_taken', dupe.status === 409 && reason(dupe) === 'slug_taken', dupe.body);
    const badMember = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Ghosts', member_ids: [randomUUID()] });
    check('groups: a member who does not exist is refused, nothing made', badMember.status === 422 && reason(badMember) === 'member_not_active'
      && await count("SELECT count(*)::int AS n FROM pm.groups WHERE slug = 'ghosts'") === 0, badMember.body);
    const ops = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Ops', slug: 'ops-team', member_ids: [s.nina] });
    const opsId = ops.body?.data?.id as string;

    as(LOGINS.morgan);
    const morganList = await session(groupsRoute.GET, 'GET', '/api/workspace/groups?search=fin');
    check('groups: a team reader lists them, searched, with is_member', morganList.status === 200 && morganList.body.data.groups.length === 1
      && morganList.body.data.groups[0].is_member === true && morganList.body.data.meta.total === 1, morganList.body);
    const mine = await session(groupsRoute.GET, 'GET', '/api/workspace/groups?member=me');
    check('groups: member=me lists only mine', mine.body?.data?.groups?.map((g: Loose) => g.id).join() === financeId, mine.body);
    const members = await session(groupMembersRoute.GET, 'GET', `/api/workspace/groups/${financeId}/members`, { id: financeId });
    check('groups: members, the lead first', members.status === 200 && members.body.data.members[0].member_id === s.morgan && members.body.data.members[0].role === 'lead'
      && members.body.data.meta.total === 3, members.body);
    const searched = await session(groupMembersRoute.GET, 'GET', `/api/workspace/groups/${financeId}/members?search=mi`, { id: financeId });
    check('groups: members searched by name', searched.body?.data?.members?.length === 1 && searched.body.data.members[0].name === 'Mia', searched.body);
    const morganEdit = await session(groupRoute.PATCH, 'PATCH', `/api/workspace/groups/${financeId}`, { id: financeId }, { name: 'Money' });
    check('groups: a member cannot edit one', morganEdit.status === 403, morganEdit.body);
    as(LOGINS.guest);
    const guestList = await session(groupsRoute.GET, 'GET', '/api/workspace/groups');
    const guestOne = await session(groupRoute.GET, 'GET', `/api/workspace/groups/${financeId}`, { id: financeId });
    check('groups: a guest sees only the groups they are in (none)', guestList.status === 200 && guestList.body.data.groups.length === 0 && guestOne.status === 404, { list: guestList.body, one: guestOne.status });
    as(LOGINS.owner);
    const opsLead = await session(groupMemberRoute.PATCH, 'PATCH', `/api/workspace/groups/${opsId}/members/${s.nina}`, { id: opsId, memberId: s.nina }, { role: 'lead' });
    const opsRead = await session(groupRoute.GET, 'GET', `/api/workspace/groups/${opsId}`, { id: opsId });
    check('groups: a member made lead from the screens, with its own slug', opsLead.status === 200 && opsRead.body?.data?.lead_count === 1 && opsRead.body.data.slug === 'ops-team', [opsLead.body, opsRead.body]);
    const opsOut = await session(groupMemberRoute.DELETE, 'DELETE', `/api/workspace/groups/${opsId}/members/${s.nina}`, { id: opsId, memberId: s.nina });
    check('groups: a member taken out from the screens', opsOut.status === 200 && await count('SELECT count(*)::int AS n FROM pm.group_members WHERE group_id = $1', [opsId]) === 0, opsOut.body);

    // v1 and MCP
    const v1Refused = await v1(v1Groups.POST, 'POST', '/api/v1/groups', {}, s.keys.ownerReadOnly, { name: 'Support' });
    check('v1 groups: a key without groups.manage is refused', v1Refused.status === 403 && reason(v1Refused) === 'missing_key_scope', v1Refused.body);
    const support = await v1(v1Groups.POST, 'POST', '/api/v1/groups', {}, s.keys.owner, { name: 'Support', member_ids: [s.mia] });
    const supportId = support.body?.data?.id as string;
    check('v1 groups: created', support.status === 201 && support.body.data.slug === 'support' && support.body.data.member_count === 1, support.body);
    const added = await v1(v1GroupMembers.POST, 'POST', `/api/v1/groups/${supportId}/members`, { id: supportId }, s.keys.owner, { member_ids: [s.morgan, s.mia], role: 'lead' });
    check('v1 groups: add members, and set the role of one already in', added.status === 200 && JSON.stringify(added.body.data) === JSON.stringify({ added: [s.morgan], updated: [s.mia] }), added.body);
    const demoted = await v1(v1GroupMember.PATCH, 'PATCH', `/api/v1/groups/${supportId}/members/${s.morgan}`, { id: supportId, memberId: s.morgan }, s.keys.owner, { role: 'member' });
    const removed = await v1(v1GroupMember.DELETE, 'DELETE', `/api/v1/groups/${supportId}/members/${s.morgan}`, { id: supportId, memberId: s.morgan }, s.keys.owner);
    const removedAgain = await v1(v1GroupMember.DELETE, 'DELETE', `/api/v1/groups/${supportId}/members/${s.morgan}`, { id: supportId, memberId: s.morgan }, s.keys.owner);
    check('v1 groups: change a role, remove a member, and 404 the second time', demoted.status === 200 && removed.status === 200 && removedAgain.status === 404, { demoted: demoted.body, removed: removed.body });
    const renamed = await v1(v1Group.PATCH, 'PATCH', `/api/v1/groups/${supportId}`, { id: supportId }, s.keys.owner, { description: 'Customer help' });
    check('v1 groups: edited', renamed.status === 200 && renamed.body.data.description === 'Customer help', renamed.body);
    const listed = await runTool(s.keys.owner, s.owner, 'list_groups', { search: 'sup' });
    check('mcp: list_groups', listed.ok === true && listed.data.length === 1 && listed.data[0].id === supportId, listed);
    const mcpMembers = await runTool(s.keys.owner, s.owner, 'list_group_members', { group_id: financeId, role: 'lead' });
    check('mcp: list_group_members filtered to leads', mcpMembers.ok === true && mcpMembers.data.length === 1 && mcpMembers.data[0].member_id === s.morgan, mcpMembers);
    const trashed = await v1(v1Group.DELETE, 'DELETE', `/api/v1/groups/${supportId}`, { id: supportId }, s.keys.owner);
    const afterTrash = await v1(v1Group.GET, 'GET', `/api/v1/groups/${supportId}`, { id: supportId }, s.keys.owner);
    check('v1 groups: Trash takes it out of reach, never out of the database', trashed.status === 200 && afterTrash.status === 404
      && await count('SELECT count(*)::int AS n FROM pm.groups WHERE id = $1 AND deleted_at IS NOT NULL', [supportId]) === 1, { trashed: trashed.body, after: afterTrash.status });
    await settle();
    check('v1 groups: writes are audited', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_type = 'group'") >= 5);

    // ── A question asked to a group ─────────────────────────────────────
    const asked = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Can we refund Acme?', asked_to_group: financeId, choices: ['Yes', 'No'] });
    const qid = asked.body?.data?.id as string;
    check('group question: asked, to the group and no one member', asked.status === 201 && asked.body.data.asked_to === null && asked.body.data.asked_to_group === financeId
      && asked.body.data.asked_to_group_name === 'Finance' && asked.body.data.asked_to_you === false, asked.body);
    const bells = await s.q<{ user_id: string }>("SELECT user_id FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1 ORDER BY user_id", [qid]);
    check('group question: every member\'s bell rings, never an outsider\'s', JSON.stringify(bells.map((b) => b.user_id).sort()) === JSON.stringify([s.morgan, s.mia, s.helper].sort()), bells);
    const title = (await s.q<{ title: string }>("SELECT title FROM pm.team_member_notifications WHERE entity_id = $1 LIMIT 1", [qid]))[0]?.title;
    check('group question: the bell names the group', title === 'Question from Finn to Finance', title);
    as(LOGINS.nina);
    const ninaAnswers = await session(sessionAnswer.POST, 'POST', `/api/workspace/questions/${qid}/answer`, { id: qid }, { choice: 'Yes' });
    const ninaList = await session(sessionQuestions.GET, 'GET', '/api/workspace/questions');
    check('group question: a non-member neither sees nor answers it', ninaAnswers.status === 404
      && !(ninaList.body?.data ?? []).some((row: Loose) => row.id === qid), { answers: ninaAnswers.status });
    as(LOGINS.mia);
    const miaList = await session(sessionQuestions.GET, 'GET', '/api/workspace/questions');
    const miaRow = (miaList.body?.data ?? []).find((row: Loose) => row.id === qid);
    check('group question: a member sees it as theirs and may answer', miaRow?.asked_to_you === true && miaRow?.can_answer === true, miaRow);
    const miaAnswer = await session(sessionAnswer.POST, 'POST', `/api/workspace/questions/${qid}/answer`, { id: qid }, { choice: 'Yes', text: 'Under $500.' });
    check('group question: any member answers, and answered_by says who', miaAnswer.status === 200 && miaAnswer.body.data.answered_by === s.mia && miaAnswer.body.data.status === 'answered', miaAnswer.body);
    check('group question: answering clears every member\'s bell', await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1 AND cleared_at IS NULL", [qid]) === 0);
    as(LOGINS.morgan);
    const late = await session(sessionAnswer.POST, 'POST', `/api/workspace/questions/${qid}/answer`, { id: qid }, { choice: 'No' });
    check('group question: a second answer is 409', late.status === 409, late.body);
    const both = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Who?', asked_to: s.morgan, asked_to_group: financeId });
    check('group question: asked_to and asked_to_group together are refused', both.status === 422 && reason(both) === 'two_addressees', both.body);
    const gone = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Anyone?', asked_to_group: supportId });
    check('group question: a group in Trash is no target', gone.status === 422 && reason(gone) === 'asked_to_group_not_found', gone.body);
    const myOnly = await v1(v1Questions.GET, 'GET', `/api/v1/questions?asked_to_group=${financeId}&status=all`, {}, s.keys.finn);
    check('group question: listed by asked_to_group', myOnly.status === 200 && myOnly.body.data.some((row: Loose) => row.id === qid), myOnly.body);

    // Approvals to a group: decided by any person in it, never an agent in it.
    const approval = await v1(v1Approvals.POST, 'POST', '/api/v1/approvals', {}, s.keys.finn, { action: { type: 'refund', summary: 'Refund Acme $400' }, asked_to_group: financeId });
    const aid = approval.body?.data?.id as string;
    check('group approval: asked', approval.status === 201 && approval.body.data.kind === 'approval' && approval.body.data.asked_to_group === financeId, approval.body);
    const helperView = await runTool(s.keys.helper, s.helper, 'get_approval', { approval_id: aid });
    check('group approval: an agent in the group sees it but cannot decide it', helperView.ok === true && helperView.data.can_answer === false && helperView.data.asked_to_you === true, helperView);
    as(LOGINS.owner);
    const bots = await session(groupsRoute.POST, 'POST', '/api/workspace/groups', {}, { name: 'Bots', member_ids: [s.helper] });
    const botsId = bots.body?.data?.id as string;
    const noPerson = await v1(v1Approvals.POST, 'POST', '/api/v1/approvals', {}, s.keys.finn, { action: { type: 'deploy', summary: 'Deploy' }, asked_to_group: botsId });
    check('group approval: a group with no person in it is refused', noPerson.status === 422 && reason(noPerson) === 'group_has_no_one', noPerson.body);
    const ownAsk = await v1(v1Approvals.POST, 'POST', '/api/v1/approvals', {}, s.keys.morgan, { action: { type: 'spend', summary: 'Buy a $90 license' }, asked_to_group: financeId });
    as(LOGINS.morgan);
    const selfDecide = await session(sessionAnswer.POST, 'POST', `/api/workspace/questions/${ownAsk.body?.data?.id}/answer`, { id: ownAsk.body?.data?.id }, { choice: 'approve' });
    as(LOGINS.mia);
    const otherDecide = await session(sessionAnswer.POST, 'POST', `/api/workspace/questions/${ownAsk.body?.data?.id}/answer`, { id: ownAsk.body?.data?.id }, { choice: 'approve' });
    check('group approval: whoever asked it, though in the group, cannot decide it (asked_self); another member can', ownAsk.status === 201
      && ownAsk.body.data.can_answer === false && selfDecide.status === 403 && /someone else/.test(selfDecide.body?.error ?? '') && otherDecide.status === 200, [ownAsk.body, selfDecide.body, otherDecide.body]);

    // ── Escalation through a group ──────────────────────────────────────
    as(LOGINS.owner);
    const toGroup = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.finn}`, { id: s.finn }, { rules: { escalate_to_group: financeId } });
    check('escalation: an agent escalates to a group', toGroup.status === 200 && toGroup.body.data.rules.agent_escalate_to_group === financeId && toGroup.body.data.rules.agent_escalate_to === null, toGroup.body);
    const recipient = await escalationRecipient(service, s.finn);
    check('escalation: the recipient is the group, and its lead when one person is needed', recipient?.kind === 'group' && recipient.id === financeId
      && (await escalationTarget(service, s.finn)) === s.morgan, recipient);
    const defaulted = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Which bank?' });
    check('escalation: a question naming no one goes to the group', defaulted.status === 201 && defaulted.body.data.asked_to_group === financeId && defaulted.body.data.asked_to === null, defaulted.body);
    const pack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.finn);
    check('escalation: the context pack names the group', pack.body?.data?.pack?.rules?.escalate_to?.kind === 'group' && pack.body.data.pack.rules.escalate_to.name === 'Finance (any member)', pack.body?.data?.pack?.rules);
    const toPerson = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.finn}`, { id: s.finn }, { rules: { escalate_to: s.nina } });
    check('escalation: choosing a person clears the group', toPerson.status === 200 && toPerson.body.data.rules.agent_escalate_to === s.nina && toPerson.body.data.rules.agent_escalate_to_group === null, toPerson.body);
    const goneGroup = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.finn}`, { id: s.finn }, { rules: { escalate_to_group: supportId } });
    check('escalation: a group in Trash is refused', goneGroup.status === 422, goneGroup.body);

    // ── Groups that own agents ──────────────────────────────────────────
    as(LOGINS.mia);
    const miaBefore = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.gale}`, { id: s.gale }, { title: 'Ledger' });
    check('owners: before, a member of no owner group cannot manage the agent', miaBefore.status === 403 && reason(miaBefore) === 'not_agent_owner', miaBefore.body);
    as(LOGINS.owner);
    const owned = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.gale}`, { id: s.gale }, { owner_group_ids: [financeId] });
    check('owners: a group owns the agent', owned.status === 200 && owned.body.data.owner_groups?.[0]?.id === financeId && owned.body.data.owner_groups[0].name === 'Finance', owned.body);
    as(LOGINS.mia);
    const miaAfter = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.gale}`, { id: s.gale }, { title: 'Ledger' });
    const miaOwned = await session(agentsRoute.GET, 'GET', '/api/workspace/agents?owner=me');
    check('owners: any member of the group manages it, and it lists as theirs', miaAfter.status === 200
      && (miaOwned.body?.data?.agents ?? []).some((a: Loose) => a.id === s.gale && a.owner_groups?.[0]?.id === financeId), { after: miaAfter.body, owned: miaOwned.body });
    as(LOGINS.nina);
    const ninaManage = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.gale}`, { id: s.gale }, { title: 'Nope' });
    check('owners: someone outside the group still cannot', ninaManage.status === 403, ninaManage.body);
    as(LOGINS.owner);
    await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.helper}`, { id: s.helper }, { owner_group_ids: [financeId] });
    check('escalation: with no target and no owner person, an owner group is next', (await escalationRecipient(service, s.helper))?.kind === 'group');
    // Helper (an agent) is in Finance, and Finance owns Gale: an agent still never owns an agent.
    const agentEdits = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.gale}`, { id: s.gale }, s.keys.helperTeam, { rules: { close_policy: 'close' } });
    check('owners: an agent in an owner group cannot manage the agent', agentEdits.status === 403 && reason(agentEdits) === 'not_agent_owner', agentEdits.body);
    check('owners: an agent in an owner group owns nothing through it', !(await agentsOwnedBy(service, s.helper)).includes(s.gale));
    // Gale joins Finance, which owns it: it still cannot rewrite its own owners.
    await s.q("INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)", [financeId, s.gale]);
    const selfOwners = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.gale}`, { id: s.gale }, s.keys.galeTeam, { owner_ids: [] });
    const selfOwnerGroups = await v1(v1Agent.PATCH, 'PATCH', `/api/v1/agents/${s.gale}`, { id: s.gale }, s.keys.galeTeam, { owner_group_ids: [] });
    check('owners: an agent never rewrites its own owners', selfOwners.status === 403 && selfOwnerGroups.status === 403
      && await count('SELECT count(*)::int AS n FROM pm.agent_owner_groups WHERE agent_id = $1', [s.gale]) === 1, [selfOwners.body, selfOwnerGroups.body]);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.mia]);
    check('owners: a suspended person owns nothing through a group', !(await isAgentOwner(service, s.gale, s.mia)));
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.mia]);
    const notGroup = await session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${s.gale}`, { id: s.gale }, { owner_group_ids: [randomUUID()] });
    check('owners: an unknown group is refused', notGroup.status === 422 && reason(notGroup) === 'owner_group_not_found', notGroup.body);

    // ── Linked identities: the link handshake ───────────────────────────
    const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
    const link = await v1(v1LinkRequests.POST, 'POST', '/api/v1/identities/link-requests', {}, s.keys.finn, { provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1', handle: '@morgan' });
    const token = tokenOf(link.body?.data?.url ?? '');
    check('link: a one-time URL on the app, never cached', link.status === 201 && link.body.data.url.startsWith('https://pm.example.com/link/pl_') && link.headers.get('cache-control') === 'no-store', link.body);
    check('link: only its hash is stored', await count('SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')]) === 1
      && await count('SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE token_hash = $1', [token]) === 0);
    const noScope = await v1(v1LinkRequests.POST, 'POST', '/api/v1/identities/link-requests', {}, s.keys.ownerReadOnly, { provider: 'slack', external_id: 'U9' });
    check('link: needs identities.link', noScope.status === 403, noScope.body);
    as(LOGINS.morgan);
    const preview = await session(linkRoute.GET, 'GET', `/api/workspace/identities/link/${token}`, { token });
    check('link: the confirm page reads the account and who asked', preview.status === 200 && preview.body.data.state === 'open' && preview.body.data.handle === '@morgan'
      && preview.body.data.requested_by_name === 'Finn' && !preview.text.includes(token), preview.body);
    const confirmed = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${token}`, { token });
    check('link: confirming stores it verified for the signed-in member', confirmed.status === 200 && confirmed.body.data.member_id === s.morgan
      && confirmed.body.data.verified === true && confirmed.body.data.verified_method === 'link', confirmed.body);
    const replay = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${token}`, { token });
    check('link: used once (a replay is 409 link_used)', replay.status === 409 && replay.body?.error?.details?.reason === 'link_used', replay.body);
    const expiring = await v1(v1LinkRequests.POST, 'POST', '/api/v1/identities/link-requests', {}, s.keys.finn, { provider: 'telegram', external_id: '777' });
    const expiringToken = tokenOf(expiring.body.data.url);
    await s.q("UPDATE pm.identity_link_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.body.data.id]);
    const expired = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${expiringToken}`, { token: expiringToken });
    check('link: an expired link is 410 link_expired and links nothing', expired.status === 410 && expired.body?.error?.details?.reason === 'link_expired'
      && await count("SELECT count(*)::int AS n FROM pm.member_identities WHERE provider = 'telegram'") === 0, expired.body);
    const forNina = await v1(v1LinkRequests.POST, 'POST', '/api/v1/identities/link-requests', {}, s.keys.finn, { provider: 'slack', external_id: 'U0NINA', workspace_id: 'T1', member_id: s.nina });
    const ninaToken = tokenOf(forNina.body.data.url);
    const wrong = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${ninaToken}`, { token: ninaToken });
    check('link: a link for someone else is 403 wrong_member and stays unused', wrong.status === 403 && wrong.body?.error?.details?.reason === 'wrong_member'
      && await count('SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE id = $1 AND consumed_at IS NULL', [forNina.body.data.id]) === 1, wrong.body);
    as(LOGINS.nina);
    const ninaOk = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${ninaToken}`, { token: ninaToken });
    check('link: the named member confirms it', ninaOk.status === 200 && ninaOk.body.data.member_id === s.nina, ninaOk.body);
    const steal = await v1(v1LinkRequests.POST, 'POST', '/api/v1/identities/link-requests', {}, s.keys.finn, { provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' });
    const stealToken = tokenOf(steal.body.data.url);
    const stolen = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${stealToken}`, { token: stealToken });
    check('link: an account linked to someone else is never moved by a link', stolen.status === 409 && stolen.body?.error?.details?.reason === 'identity_linked_elsewhere'
      && (await s.q<{ member_id: string }>("SELECT member_id FROM pm.member_identities WHERE external_id = 'U0MORGAN'"))[0].member_id === s.morgan, stolen.body);
    const bogus = await session(linkRoute.GET, 'GET', '/api/workspace/identities/link/pl_nope', { token: 'pl_nope' });
    check('link: an unknown token is 404', bogus.status === 404, bogus.body);

    // ── Admin linking ───────────────────────────────────────────────────
    as(LOGINS.morgan);
    const notAdmin = await session(adminIdentities.POST, 'POST', '/api/workspace/identities', {}, { identities: [{ member_id: s.mia, provider: 'email', external_id: 'mia@chat.example' }] });
    check('admin link: a member without team.manage is refused', notAdmin.status === 403, notAdmin.body);
    as(LOGINS.owner);
    const bulk = await session(adminIdentities.POST, 'POST', '/api/workspace/identities', {}, { identities: [
      { member_id: s.mia, provider: 'email', external_id: 'Mia@Chat.Example' },
      { member_id: s.mia, provider: 'teams', external_id: 'mia-teams', workspace_id: 'tenant-1', handle: 'Mia R' },
      { member_id: s.nina, provider: 'discord', external_id: 'nina#1', verified: false },
    ] });
    check('admin link: linked in bulk, verified as admin unless told not to', bulk.status === 200 && bulk.body.data.created === 3
      && bulk.body.data.linked.find((i: Loose) => i.provider === 'email')?.external_id === 'mia@chat.example'
      && bulk.body.data.linked.find((i: Loose) => i.provider === 'teams')?.verified_method === 'admin'
      && bulk.body.data.linked.find((i: Loose) => i.provider === 'discord')?.verified === false, bulk.body);
    const conflict = await session(adminIdentities.POST, 'POST', '/api/workspace/identities', {}, { identities: [
      { member_id: s.nina, provider: 'github', external_id: 'nina-gh' },
      { member_id: s.nina, provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' },
    ] });
    check('admin link: one linked elsewhere refuses the whole call before any write', conflict.status === 409 && conflict.body?.error?.details?.reason === 'identity_linked_elsewhere'
      && await count("SELECT count(*)::int AS n FROM pm.member_identities WHERE provider = 'github'") === 0, conflict.body);
    const v1Bulk = await v1(v1Identities.POST, 'POST', '/api/v1/identities', {}, s.keys.owner, { identities: [{ member_id: s.owner, provider: 'slack', external_id: 'U0OWNER', workspace_id: 'T1' }] });
    const v1BulkRefused = await v1(v1Identities.POST, 'POST', '/api/v1/identities', {}, s.keys.finn, { identities: [{ member_id: s.finn, provider: 'slack', external_id: 'U0FINN' }] });
    check('admin link: over v1 with team.manage; refused without it', v1Bulk.status === 200 && v1Bulk.body.data.created === 1 && v1BulkRefused.status === 403, { ok: v1Bulk.body, refused: v1BulkRefused.body });
    const discordId = (await s.q<{ id: string }>("SELECT id FROM pm.member_identities WHERE provider = 'discord'"))[0].id;
    as(LOGINS.morgan);
    const memberMove = await session(adminMove.POST, 'POST', `/api/workspace/identities/${discordId}/move`, { id: discordId }, { member_id: s.morgan });
    const memberUnlink = await session(adminIdentity.DELETE, 'DELETE', `/api/workspace/identities/${discordId}`, { id: discordId });
    check('admin move and unlink: refused without team.manage', memberMove.status === 403 && memberUnlink.status === 403, [memberMove.body, memberUnlink.body]);
    as(LOGINS.owner);
    const same = await session(adminMove.POST, 'POST', `/api/workspace/identities/${discordId}/move`, { id: discordId }, { member_id: s.nina });
    check('admin move: to the member who has it already is refused, and nothing changes', same.status === 422
      && await count('SELECT count(*)::int AS n FROM pm.member_identities WHERE id = $1', [discordId]) === 1, same.body);
    const moved = await session(adminMove.POST, 'POST', `/api/workspace/identities/${discordId}/move`, { id: discordId }, { member_id: s.mia });
    check('admin move: unlinked from one member, linked verified to another', moved.status === 200 && moved.body.data.removed.member_id === s.nina
      && moved.body.data.linked.member_id === s.mia && moved.body.data.linked.verified_method === 'admin', moved.body);
    const unlinkedByAdmin = await session(adminIdentity.DELETE, 'DELETE', `/api/workspace/identities/${moved.body?.data?.linked?.id}`, { id: moved.body?.data?.linked?.id });
    check('admin unlink: an Owner unlinks anyone\'s account', unlinkedByAdmin.status === 200 && await count("SELECT count(*)::int AS n FROM pm.member_identities WHERE provider = 'discord'") === 0, unlinkedByAdmin.body);

    // ── Lookups and their scopes ────────────────────────────────────────
    const resolved = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0MORGAN&workspace_id=T1', {}, s.keys.finn);
    check('resolve: a verified account names its member', resolved.status === 200 && resolved.body.data.member.id === s.morgan && resolved.body.data.member.active === true
      && resolved.body.data.member.name === 'Morgan', resolved.body);
    const unverified = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=discord&external_id=nina%231', {}, s.keys.finn);
    const unknownId = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0NOBODY&workspace_id=T1', {}, s.keys.finn);
    const otherWorkspace = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0MORGAN', {}, s.keys.finn);
    check('resolve: unverified, unknown and another workspace all read 404 identity_not_found', [unverified, unknownId, otherWorkspace].every((a) => a.status === 404 && reason(a) === 'identity_not_found'),
      [unverified.status, unknownId.status, otherWorkspace.status]);
    const emailCase = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=email&external_id=MIA%40chat.example', {}, s.keys.finn);
    check('resolve: an email resolves whatever its case', emailCase.status === 200 && emailCase.body.data.member.id === s.mia, emailCase.body);
    const noRead = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0MORGAN&workspace_id=T1', {}, s.keys.finnNoActFor);
    check('resolve: needs identities.read', noRead.status === 403 && reason(noRead) === 'missing_key_scope', noRead.body);
    const badProvider = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=IRC&external_id=x', {}, s.keys.finn);
    check('resolve: a bad provider is 422', badProvider.status === 422, badProvider.body);
    const reachMia = await v1(v1MemberIdentities.GET, 'GET', `/api/v1/members/${s.mia}/identities?provider=teams`, { id: s.mia }, s.keys.finn);
    check('reach: a member\'s verified accounts, by provider', reachMia.status === 200 && reachMia.body.data.identities.length === 1 && reachMia.body.data.identities[0].handle === 'Mia R', reachMia.body);
    const reachNina = await v1(v1MemberIdentities.GET, 'GET', `/api/v1/members/${s.nina}/identities`, { id: s.nina }, s.keys.finn);
    check('reach: unverified accounts are never listed for a harness', reachNina.body?.data?.identities?.every((i: Loose) => i.verified) && !reachNina.body.data.identities.some((i: Loose) => i.provider === 'discord'), reachNina.body);
    const reachGroup = await v1(v1GroupIdentities.GET, 'GET', `/api/v1/groups/${financeId}/identities?provider=slack`, { id: financeId }, s.keys.finn);
    const morganRow = reachGroup.body?.data?.members?.find((m: Loose) => m.id === s.morgan);
    check('reach: a group\'s members, leads first, with their accounts', reachGroup.status === 200 && reachGroup.body.data.members[0].id === s.morgan
      && morganRow?.identities?.[0]?.external_id === 'U0MORGAN' && reachGroup.body.data.group.name === 'Finance', reachGroup.body);
    const mcpResolve = await runTool(s.keys.finn, s.finn, 'resolve_identity', { provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' });
    check('mcp: resolve_identity', mcpResolve.ok === true && mcpResolve.data.member.id === s.morgan, mcpResolve);
    const finnAccess = (await resolveApiKey(s.keys.finn)).access;
    const visible = toolsFor({ access: finnAccess, scopes: ['tasks.read', 'identities.read', 'identities.link'], readOnly: false, profile: 'generic' }).map((t) => t.name);
    check('mcp: the identity tools follow their scopes', visible.includes('resolve_identity') && visible.includes('create_identity_link') && !visible.includes('create_group'), visible.filter((n) => /identit|group/.test(n)));

    // A member's own
    as(LOGINS.mia);
    const own = await session(meIdentities.GET, 'GET', '/api/workspace/me/identities');
    check('own: a member lists their accounts', own.status === 200 && own.body.data.identities.length === 2, own.body);
    const ninaIdentity = (await s.q<{ id: string }>("SELECT id FROM pm.member_identities WHERE member_id = $1 AND provider = 'slack'", [s.owner]))[0].id;
    const notMine = await session(meIdentity.DELETE, 'DELETE', `/api/workspace/me/identities/${ninaIdentity}`, { id: ninaIdentity });
    check('own: someone else\'s account is 404', notMine.status === 404, notMine.body);
    const miaEmail = own.body.data.identities.find((i: Loose) => i.provider === 'email').id;
    const unlinked = await session(meIdentity.DELETE, 'DELETE', `/api/workspace/me/identities/${miaEmail}`, { id: miaEmail });
    check('own: a member unlinks their own', unlinked.status === 200 && await count('SELECT count(*)::int AS n FROM pm.member_identities WHERE id = $1', [miaEmail]) === 0, unlinked.body);

    // ── Delegation: minting rules ───────────────────────────────────────
    const morganSlack = { provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' };
    const noActFor = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finnNoActFor, morganSlack);
    check('mint: needs agents.act_for on the key', noActFor.status === 403 && reason(noActFor) === 'missing_key_scope', noActFor.body);
    const personKey = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.owner, morganSlack);
    check('mint: only an agent\'s key acts for someone', personKey.status === 403 && reason(personKey) === 'not_an_agent', personKey.body);
    const unverifiedMint = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, { provider: 'discord', external_id: 'nina#1' });
    const unknownMint = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, { provider: 'slack', external_id: 'U0NOBODY', workspace_id: 'T1' });
    check('mint: an unverified or unknown account is 403 identity_not_verified', unverifiedMint.status === 403 && reason(unverifiedMint) === 'identity_not_verified'
      && unknownMint.status === 403 && reason(unknownMint) === 'identity_not_verified', [unverifiedMint.body, unknownMint.body]);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.nina]);
    const suspendedMint = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, { provider: 'slack', external_id: 'U0NINA', workspace_id: 'T1' });
    const suspendedResolve = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0NINA&workspace_id=T1', {}, s.keys.finn);
    check('mint: a suspended person is 403 principal_suspended, and resolves active false', suspendedMint.status === 403 && reason(suspendedMint) === 'principal_suspended'
      && suspendedResolve.status === 200 && suspendedResolve.body.data.member.active === false, [suspendedMint.body, suspendedResolve.body]);
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.nina]);
    const grant = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, morganSlack);
    const actFor = grant.body?.data?.token as string;
    check('mint: a token for the verified person, bound to this agent, for about 15 minutes, never cached', grant.status === 201 && /^pd_[0-9a-f]{64}$/.test(actFor ?? '')
      && grant.body.data.agent_id === s.finn && grant.body.data.principal.id === s.morgan && grant.body.data.header === 'X-Act-For'
      && Math.abs(Date.parse(grant.body.data.expires_at) - Date.now() - 15 * 60_000) < 60_000 && grant.headers.get('cache-control') === 'no-store', grant.body);
    check('mint: only its hash is stored', await count('SELECT count(*)::int AS n FROM pm.delegation_tokens WHERE token_hash = $1', [createHash('sha256').update(actFor).digest('hex')]) === 1);
    const withKey = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, morganSlack, actFor);
    // Refused either way: the person does not hold agents.act_for, and a request acting for someone never mints another.
    check('mint: a request already acting for someone cannot mint another', withKey.status === 403, withKey.body);

    // ── Delegation: the intersection ────────────────────────────────────
    const alone = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.secret}`, { id: s.secret }, s.keys.finn);
    const forMorgan = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.secret}`, { id: s.secret }, s.keys.finn, undefined, actFor);
    const sharedForMorgan = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, actFor);
    check('intersect: the agent alone opens Secret; acting for Morgan, who cannot, it cannot', alone.status === 200 && forMorgan.status === 403 && reason(forMorgan) === 'project_scope', [alone.status, forMorgan.body]);
    check('intersect: a project both reach stays open', sharedForMorgan.status === 200, sharedForMorgan.body);
    const resolvedFor = await resolveApiKey(s.keys.finn, actFor);
    check('intersect: resolveApiKey answers the person and the narrowed access', resolvedFor.principal?.id === s.morgan && resolvedFor.access.principal_id === s.morgan
      && !resolvedFor.access.project_ids.includes(s.secret) && resolvedFor.access.project_ids.includes(s.shared), resolvedFor.access);
    const mcpSecret = await runTool(s.keys.finn, s.finn, 'get_project', { project_id: s.secret }, actFor);
    const mcpSecretAlone = await runTool(s.keys.finn, s.finn, 'get_project', { project_id: s.secret });
    check('intersect: MCP carries the token on to its routes', mcpSecret.ok === false && mcpSecret.status === 403 && mcpSecretAlone.ok === true, [mcpSecret, mcpSecretAlone.ok]);
    const secretTask = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.finn, { project_id: s.secret, title: 'Not for Morgan' }, actFor);
    check('intersect: no task on a project the person cannot open', secretTask.status === 403, secretTask.body);

    // ── Delegation: principal_id on what it makes ──────────────────────
    const task = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.finn, { project_id: s.shared, title: 'Book the venue for Morgan' }, actFor);
    const taskId = task.body?.data?.id as string;
    const comment = await v1(v1Comments.POST, 'POST', `/api/v1/tasks/${taskId}/comments`, { id: taskId }, s.keys.finn, { user_id: s.finn, text: 'Asked by Morgan in Slack.' }, actFor);
    const run = await v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.finn, { title: 'Venue booking', task_id: taskId }, actFor);
    const forQuestion = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Budget for the venue?', asked_to: s.owner, task_id: taskId }, actFor);
    await settle();
    check('principal: the writes worked', task.status === 201 && comment.status === 201 && run.status === 201 && forQuestion.status === 201, [task.status, comment.body, run.body, forQuestion.status]);
    const principalOf = async (table: string, id: string) => (await s.q<{ principal_id: string | null }>(`SELECT principal_id FROM pm.${table} WHERE id = $1`, [id]))[0]?.principal_id;
    check('principal: stamped on the task, comment, run and question', await principalOf('tasks', taskId) === s.morgan
      && await principalOf('task_comments', comment.body?.data?.id) === s.morgan
      && await principalOf('agent_runs', run.body?.data?.id) === s.morgan
      && await principalOf('questions', forQuestion.body?.data?.id) === s.morgan,
    { task: await principalOf('tasks', taskId), run: await principalOf('agent_runs', run.body?.data?.id) });
    check('principal: the run and the question say whom they were for', run.body?.data?.principal_id === s.morgan
      && forQuestion.body?.data?.principal_id === s.morgan && forQuestion.body?.data?.principal_name === 'Morgan', [run.body?.data?.principal_id, forQuestion.body?.data]);
    check('principal: stamped on the audit rows of those writes', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE principal_id = $1 AND entity_id = $2", [s.morgan, taskId]) >= 1
      && await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE principal_id = $1 AND entity_type = 'question'", [s.morgan]) === 1);

    // ── Acting for a person never reads the agent's own reach ───────────
    const secretAsk = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Secret pricing?', asked_to: s.owner, project_id: s.secret });
    const looseAsk = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Loose end?', asked_to: s.owner });
    const forMorganLoose = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'For Morgan, on nothing', asked_to: s.owner }, actFor);
    const secretRun = await v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.finn, { title: 'Secret run', project_id: s.secret });
    const looseRun = await v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.finn, { title: 'Loose run' });
    const forMorganRun = await v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.finn, { title: 'Run for Morgan' }, actFor);
    const ownReminder = await v1(v1Reminders.POST, 'POST', '/api/v1/reminders', {}, s.keys.finn, { title: 'Agent note to self' });
    check('leak setup: the agent\'s own rows were made', [secretAsk, looseAsk, forMorganLoose, secretRun, looseRun, forMorganRun, ownReminder].every((a) => a.status === 201),
      [secretAsk, looseAsk, forMorganLoose, secretRun, looseRun, forMorganRun, ownReminder].map((a) => a.status));
    const asItself = await v1(v1Questions.GET, 'GET', '/api/v1/questions?limit=100', {}, s.keys.finn);
    const asMorgan = await v1(v1Questions.GET, 'GET', '/api/v1/questions?limit=100', {}, s.keys.finn, undefined, actFor);
    const idsOf = (answer: Answer) => new Set(((answer.body?.data ?? []) as Loose[]).map((row) => row.id));
    const itself = idsOf(asItself);
    const forHim = idsOf(asMorgan);
    check('leak: as itself the agent lists the questions it asked', itself.has(secretAsk.body.data.id) && itself.has(looseAsk.body.data.id));
    check('leak: acting for Morgan, no question on a project he cannot open, nor one on nothing it asked for itself', !forHim.has(secretAsk.body.data.id) && !forHim.has(looseAsk.body.data.id),
      [...forHim]);
    check('leak: acting for Morgan, what it asked for him and on his projects still lists', forHim.has(forMorganLoose.body.data.id) && forHim.has(forQuestion.body.data.id), [...forHim]);
    const secretOne = await v1(v1Question.GET, 'GET', `/api/v1/questions/${secretAsk.body.data.id}`, { id: secretAsk.body.data.id }, s.keys.finn, undefined, actFor);
    const looseOne = await v1(v1Question.GET, 'GET', `/api/v1/questions/${looseAsk.body.data.id}`, { id: looseAsk.body.data.id }, s.keys.finn, undefined, actFor);
    check('leak: reading one of those by id while acting for Morgan is 404', secretOne.status === 404 && looseOne.status === 404, [secretOne.status, looseOne.status]);
    const runsItself = idsOf(await v1(v1Runs.GET, 'GET', '/api/v1/agents/runs?limit=100', {}, s.keys.finn));
    const runsForHim = idsOf(await v1(v1Runs.GET, 'GET', '/api/v1/agents/runs?limit=100', {}, s.keys.finn, undefined, actFor));
    check('leak: as itself the agent lists its runs', runsItself.has(secretRun.body.data.id) && runsItself.has(looseRun.body.data.id));
    check('leak: acting for Morgan, only runs done for him or on his projects', !runsForHim.has(secretRun.body.data.id) && !runsForHim.has(looseRun.body.data.id)
      && runsForHim.has(forMorganRun.body.data.id) && runsForHim.has(run.body.data.id), [...runsForHim]);
    const secretRunOne = await v1(v1Run.GET, 'GET', `/api/v1/agents/runs/${secretRun.body.data.id}`, { id: secretRun.body.data.id }, s.keys.finn, undefined, actFor);
    const looseRunOne = await v1(v1Run.GET, 'GET', `/api/v1/agents/runs/${looseRun.body.data.id}`, { id: looseRun.body.data.id }, s.keys.finn, undefined, actFor);
    const himRunOne = await v1(v1Run.GET, 'GET', `/api/v1/agents/runs/${forMorganRun.body.data.id}`, { id: forMorganRun.body.data.id }, s.keys.finn, undefined, actFor);
    check('leak: a run read by id follows the same rule', secretRunOne.status === 404 && looseRunOne.status === 404 && himRunOne.status === 200, [secretRunOne.status, looseRunOne.status, himRunOne.status]);
    const remindersItself = idsOf(await v1(v1Reminders.GET, 'GET', '/api/v1/reminders?limit=100', {}, s.keys.finn));
    const remindersForHim = idsOf(await v1(v1Reminders.GET, 'GET', '/api/v1/reminders?limit=100', {}, s.keys.finn, undefined, actFor));
    check('leak: the agent\'s own reminder on nothing is not his', remindersItself.has(ownReminder.body.data.id) && !remindersForHim.has(ownReminder.body.data.id), [...remindersForHim]);
    const bell = await v1(v1Notifications.GET, 'GET', '/api/v1/notifications', {}, s.keys.finn, undefined, actFor);
    check('leak: the agent\'s own bell is closed while acting for someone', bell.status === 403 && reason(bell) === 'act_for_not_allowed', bell.body);

    // ── No token: unchanged ─────────────────────────────────────────────
    const plainTask = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.finn, { project_id: s.secret, title: 'As itself' });
    const plainRun = await v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.finn, { title: 'As itself' });
    const plainQuestion = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'Plain?', asked_to: s.owner });
    await settle();
    check('no token: the agent acts as itself, as before', plainTask.status === 201 && plainRun.status === 201 && plainQuestion.status === 201
      && await principalOf('tasks', plainTask.body.data.id) === null && await principalOf('agent_runs', plainRun.body.data.id) === null
      && !('principal_id' in plainRun.body.data) && !('principal_id' in plainQuestion.body.data) && !('asked_to_group' in plainQuestion.body.data),
    [plainTask.status, plainRun.body?.data, plainQuestion.body?.data]);
    check('no token: its audit rows name no one', await count('SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_id = $1 AND principal_id IS NULL', [plainTask.body.data.id]) >= 1);

    // ── Delegation: bound, expiry, revocation, scope, suspension ───────
    const borrowed = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.gale, undefined, actFor);
    check('bound: another agent\'s key cannot use the token', borrowed.status === 401 && reason(borrowed) === 'act_for_invalid', borrowed.body);
    const garbage = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, 'pd_nope');
    check('invalid: a token that does not exist is 401 act_for_invalid', garbage.status === 401 && reason(garbage) === 'act_for_invalid', garbage.body);
    const scopeLost = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finnNoActFor, undefined, actFor);
    check('scope: a key without agents.act_for cannot use one', scopeLost.status === 403 && reason(scopeLost) === 'missing_key_scope', scopeLost.body);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.morgan]);
    const suspendedUse = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, actFor);
    check('suspended: a token for a suspended person stops working', suspendedUse.status === 403 && reason(suspendedUse) === 'principal_suspended', suspendedUse.body);
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.morgan]);
    await s.q("UPDATE pm.delegation_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [grant.body.data.id]);
    const expiredUse = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, actFor);
    check('expiry: an expired token is 401 act_for_invalid', expiredUse.status === 401 && reason(expiredUse) === 'act_for_invalid', expiredUse.body);
    const second = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, morganSlack);
    const galeRevoke = await v1(v1Delegation.DELETE, 'DELETE', `/api/v1/delegations/${second.body.data.id}`, { id: second.body.data.id }, s.keys.gale);
    const revoked = await v1(v1Delegation.DELETE, 'DELETE', `/api/v1/delegations/${second.body.data.id}`, { id: second.body.data.id }, s.keys.finn);
    const revokedUse = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, second.body.data.token);
    check('revoke: only its agent revokes it, and then it is refused', galeRevoke.status === 404 && revoked.status === 200 && revokedUse.status === 401 && reason(revokedUse) === 'act_for_invalid', [galeRevoke.status, revoked.body, revokedUse.body]);
    const third = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, morganSlack);
    const morganIdentity = (await s.q<{ id: string }>("SELECT id FROM pm.member_identities WHERE external_id = 'U0MORGAN'"))[0].id;
    as(LOGINS.morgan);
    await session(meIdentity.DELETE, 'DELETE', `/api/workspace/me/identities/${morganIdentity}`, { id: morganIdentity });
    const unlinkedUse = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, third.body.data.token);
    check('revoke: unlinking the account revokes the tokens minted for it', unlinkedUse.status === 401 && reason(unlinkedUse) === 'act_for_invalid', unlinkedUse.body);

    // ── Delegation: a signed-in person lets an agent act for them ──────
    as(LOGINS.mia);
    const sessionGrant = await session(sessionDelegations.POST, 'POST', '/api/workspace/delegations', {}, { agent_id: s.finn });
    check('session mint: a person lets an agent act for them', sessionGrant.status === 201 && sessionGrant.body.data.principal.id === s.mia && sessionGrant.headers.get('cache-control') === 'no-store', sessionGrant.body);
    const sessionUse = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.secret}`, { id: s.secret }, s.keys.finn, undefined, sessionGrant.body?.data?.token);
    check('session mint: the agent then acts within the person\'s reach', sessionUse.status === 403 && reason(sessionUse) === 'project_scope', sessionUse.body);
    const notAllowed = await session(sessionDelegations.POST, 'POST', '/api/workspace/delegations', {}, { agent_id: s.helper });
    const notAgent = await session(sessionDelegations.POST, 'POST', '/api/workspace/delegations', {}, { agent_id: s.morgan });
    check('session mint: only an agent allowed to act for people', notAllowed.status === 403 && notAllowed.body?.error?.details?.reason === 'agent_cannot_act_for' && notAgent.status === 404, [notAllowed.body, notAgent.status]);

    // Admin unlink over v1 revokes the tokens minted for the account.
    const relink = await v1(v1Identities.POST, 'POST', '/api/v1/identities', {}, s.keys.owner, { identities: [{ member_id: s.morgan, provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' }] });
    const fresh = await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.finn, morganSlack);
    const freshOk = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, fresh.body?.data?.token);
    const relinkedId = relink.body?.data?.linked?.[0]?.id;
    const v1MoveRefused = await v1(v1IdentityMove.POST, 'POST', `/api/v1/identities/${relinkedId}/move`, { id: relinkedId }, s.keys.finn, { member_id: s.mia });
    const v1Unlink = await v1(v1Identity.DELETE, 'DELETE', `/api/v1/identities/${relinkedId}`, { id: relinkedId }, s.keys.ownerTeam);
    const afterUnlink = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finn, undefined, fresh.body?.data?.token);
    check('admin unlink over v1: needs team.manage, and revokes the tokens minted for the account', freshOk.status === 200 && v1MoveRefused.status === 403
      && v1Unlink.status === 200 && afterUnlink.status === 401 && reason(afterUnlink) === 'act_for_invalid', [freshOk.status, v1MoveRefused.status, v1Unlink.body, afterUnlink.body]);
    const v1Relink = await v1(v1Identities.POST, 'POST', '/api/v1/identities', {}, s.keys.owner, { identities: [{ member_id: s.morgan, provider: 'slack', external_id: 'U0MORGAN', workspace_id: 'T1' }] });
    const v1Moved = await v1(v1IdentityMove.POST, 'POST', `/api/v1/identities/${v1Relink.body?.data?.linked?.[0]?.id}/move`, { id: v1Relink.body?.data?.linked?.[0]?.id }, s.keys.ownerTeam, { member_id: s.mia });
    const nowMia = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U0MORGAN&workspace_id=T1', {}, s.keys.finn);
    check('admin move over v1: the account now resolves to the new member', v1Moved.status === 200 && nowMia.body?.data?.member?.id === s.mia, [v1Moved.body, nowMia.body]);

    // ── The convention in the context pack ──────────────────────────────
    const finnPack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.finn);
    const helperPack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.finnNoActFor);
    check('context: a key that may act for people gets the Acting for someone convention; others do not', (finnPack.body?.data?.pack?.conventions ?? []).includes(ACTING_FOR_CONVENTION)
      && !(helperPack.body?.data?.pack?.conventions ?? []).includes(ACTING_FOR_CONVENTION), finnPack.body?.data?.pack?.conventions);

    // ── Scale: 500 members and 50 groups ────────────────────────────────
    await db.exec('RESET ROLE');
    await db.exec(`INSERT INTO pm.team_members (name, email, role)
      SELECT 'Person ' || lpad(i::text, 3, '0'), 'person' || i || '@example.com', 'member' FROM generate_series(1, 500) i`);
    await db.exec(`INSERT INTO pm.groups (name, slug) SELECT 'Team ' || lpad(i::text, 2, '0'), 'team-' || i FROM generate_series(1, 50) i`);
    await db.exec(`INSERT INTO pm.group_members (group_id, member_id, role)
      SELECT g.id, m.id, CASE WHEN m.name = 'Person 001' THEN 'lead' ELSE 'member' END
      FROM pm.groups g JOIN pm.team_members m ON m.name LIKE 'Person %'
      WHERE g.slug = 'team-1' OR (g.slug LIKE 'team-%' AND (substring(m.name from 8)::int % 50) = (substring(g.slug from 6)::int % 50))`);
    await db.exec(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method)
      SELECT id, 'slack', 'U' || substring(name from 8), 'T1', now(), 'admin' FROM pm.team_members WHERE name LIKE 'Person %'`);
    const team1 = (await s.q<{ id: string }>("SELECT id FROM pm.groups WHERE slug = 'team-1'"))[0].id;
    as(LOGINS.owner);
    const started = Date.now();
    const page1 = await session(groupsRoute.GET, 'GET', '/api/workspace/groups?limit=25');
    const page3 = await session(groupsRoute.GET, 'GET', '/api/workspace/groups?limit=25&page=3');
    check('scale: groups paged with a total', page1.body?.data?.groups?.length === 25 && page1.body.data.meta.total >= 52 && page3.body.data.groups.length >= 2, page1.body?.data?.meta);
    const bigMembers = await session(groupMembersRoute.GET, 'GET', `/api/workspace/groups/${team1}/members?limit=100&page=5`, { id: team1 });
    check('scale: a 500-member group reads 100 at a time', bigMembers.body?.data?.members?.length === 100 && bigMembers.body.data.meta.total === 500, bigMembers.body?.data?.meta);
    const counted = page1.body.data.groups.find((g: Loose) => g.id === team1);
    check('scale: counts come from the counts view', counted?.member_count === 500 && counted?.lead_count === 1, counted);
    const reachBig = await v1(v1GroupIdentities.GET, 'GET', `/api/v1/groups/${team1}/identities?provider=slack&limit=100&page=2`, { id: team1 }, s.keys.finn);
    check('scale: a big group\'s accounts, paged', reachBig.status === 200 && reachBig.body.data.members.length === 100 && reachBig.body.data.members.every((m: Loose) => m.identities.length === 1)
      && reachBig.body.meta.total === 500, reachBig.body?.meta);
    const bigAsk = await v1(v1Questions.POST, 'POST', '/api/v1/questions', {}, s.keys.finn, { question: 'All hands: who can cover Friday?', asked_to_group: team1 });
    check('scale: a question to 500 people rings 500 bells', bigAsk.status === 201
      && await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1", [bigAsk.body.data.id]) === 500, bigAsk.body);
    const personLogin = { id: '00000000-0000-4000-8000-00000000b099', email: 'person250@example.com' };
    await s.q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [personLogin.id, personLogin.email]);
    await s.q("UPDATE pm.team_members SET auth_user_id = $1 WHERE name = 'Person 250'", [personLogin.id]);
    as(personLogin);
    const personList = await session(sessionQuestions.GET, 'GET', '/api/workspace/questions');
    check('scale: one of the 500 sees it as theirs', (personList.body?.data ?? []).some((row: Loose) => row.id === bigAsk.body.data.id && row.asked_to_you === true), personList.status);
    const resolvedBig = await v1(v1Resolve.GET, 'GET', '/api/v1/identities/resolve?provider=slack&external_id=U250&workspace_id=T1', {}, s.keys.finn);
    check('scale: resolving one of 500 accounts', resolvedBig.status === 200 && resolvedBig.body.data.member.name === 'Person 250', resolvedBig.body);
    check('scale: the reads finish in good time', Date.now() - started < 60_000, Date.now() - started);
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
