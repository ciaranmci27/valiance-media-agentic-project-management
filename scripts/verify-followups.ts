/**
 * Follow-ups (20261125000200_followups.sql), over the real routes and
 * services, a fake PostgREST over PGlite with the full schema:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   what the previous release writes still works (its status writes are
 *   stamped), the new functions are the database's own, and only the rows
 *   the group copying made are removed.
 * - Wake signal: a message sent back, answered or moved out of Filtered is
 *   stamped requeued_at; GET /api/v1/inbox/signal (and the MCP
 *   get_inbox_signal) adds plans_newest_queued_at, newer than any received_at
 *   for an old message sent back, every other field as before.
 * - Personal key expiry: expires_in_days on POST /api/workspace/api-keys and
 *   POST /api/v1/api-keys, the workspace's personal key lifetime as the
 *   default (every member reads it, only an Owner changes it), and the New
 *   key dialog's choices.
 * - An approved suggestion made from an email links the email to its task,
 *   for the approver only, while they read the email's inbox.
 * - Group handlers: their members read the inbox while in a live handler
 *   group, in the database and in the app, and lose it when they leave, the
 *   group is trashed or stops handling it; nothing is copied any more.
 *
 *   npm run -s test:followups
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
import { keyLifetimeChoices, keyLifetimeDays } from '../src/lib/developers-settings';

const MIGRATION = '20261125000200_followups.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- FOLLOW-UPS (20261125000200_followups.sql)';
const APP = 'https://pm.example.com';
const DAY = 86_400_000;
/** A time from PGlite (a Date) or PostgREST (a string), in ms. */
const ms = (value: unknown) => new Date(value as string).getTime();

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOGINS = {
  owner: { id: id(901), email: 'olivia@agency.example' },
  ana: { id: id(902), email: 'ana@agency.example' },
  ben: { id: id(903), email: 'ben@agency.example' },
  cara: { id: id(904), email: 'cara@agency.example' },
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

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  check('no em dashes in the migration', !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const none = keyLifetimeChoices(null);
  check('dialog: no workspace lifetime starts on No expiry, with 30 days, 90 days, 1 year and No expiry',
    none.initial === 'none' && JSON.stringify(none.options.map((o) => o.label)) === '["30 days","90 days","1 year","No expiry"]'
      && none.options.find((o) => o.value === 'none')!.description.startsWith("Your workspace's default"), none);
  const ninety = keyLifetimeChoices(90, undefined, { owner: true });
  check('dialog: a standard lifetime starts on it, marked as the default', ninety.initial === '90' && ninety.options.length === 4
    && ninety.options.find((o) => o.value === '90')!.description.startsWith("Your workspace's default")
    && !ninety.options.find((o) => o.value === 'none')!.description.startsWith("Your workspace's"), ninety);
  const odd = keyLifetimeChoices(14, undefined, { owner: true });
  check('dialog: another lifetime is offered too, in order', odd.initial === '14' && JSON.stringify(odd.options.map((o) => o.value)) === '["14","30","90","365","none"]', odd);
  check('dialog: a choice is days or null', keyLifetimeDays('365') === 365 && keyLifetimeDays('none') === null);
  const capped = keyLifetimeChoices(90);
  check('dialog: for a non-Owner a lifetime is the limit: only choices within it, no No expiry', capped.initial === '90'
    && JSON.stringify(capped.options.map((o) => o.value)) === '["30","90"]', capped);
  const tight = keyLifetimeChoices(14);
  check('dialog: a lifetime below every standard choice is the only one', JSON.stringify(tight.options.map((o) => o.value)) === '["14"]', tight);
  const ownerChoices = keyLifetimeChoices(90, undefined, { owner: true });
  check('dialog: an Owner gets every choice and No expiry, starting on the default', ownerChoices.initial === '90'
    && JSON.stringify(ownerChoices.options.map((o) => o.value)) === '["30","90","365","none"]', ownerChoices);
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the section is there, after handoff', at > 0 && banner > 0 && SCHEMA_SQL.indexOf('-- HANDOFF, CONTEXT SCOPES AND REGISTRIES (') < at);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Re-queued mail')).trim();
  check('schema.sql: the section mirrors the migration body', body.length > 2000 && SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await old.exec('RESET ROLE');
    return (await old.query<T>(sql, params)).rows;
  };
  const member = async (name: string, role = 'member', login?: { id: string; email: string }) => {
    const memberId = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@agency.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'inbound_email.read', 'app', 'allow')", [memberId]);
    return memberId;
  };
  await old.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q("UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test'");
  const ownerId = await member('Olivia', 'owner', LOGINS.owner);
  const bot = await member('Bot', 'agent');
  const p1 = await member('Pia', 'member', LOGINS.ana);
  const p2 = await member('Pete');
  const p3 = await member('Pam');
  const quin = await member('Quin');
  const rae = await member('Rae');
  const mo = await member('Mo', 'agent');
  const admin = await member('Ada', 'admin', LOGINS.ben);
  const inbox = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address, handler_member_id) VALUES ('Support', 'support@agency.example', $1) RETURNING id", [bot]))[0].id;
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Support', 'support') RETURNING id"))[0].id;
  // Before the group handles it: Rae's own grant (no creator, older), Quin's from an Owner.
  await q("INSERT INTO pm.inbox_access (inbox_id, member_id, created_at) VALUES ($1, $2, now() - interval '1 day')", [inbox, rae]);
  await q('INSERT INTO pm.inbox_access (inbox_id, member_id, created_by) VALUES ($1, $2, $3)', [inbox, quin, ownerId]);
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3)', [group, p1, bot]);
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id) VALUES ($1, $2)', [inbox, group]);
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id) VALUES ($1, $2)', [inbox, mo]);
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3), ($1, $4), ($1, $5), ($1, $6)', [group, p2, p3, quin, rae, mo]);
  await q('DELETE FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [group, p3]);
  const granted = async () => (await q<{ member_id: string }>('SELECT member_id FROM pm.inbox_access WHERE inbox_id = $1', [inbox])).map((r) => r.member_id).sort();
  check('before: 2.0.30 copies the group into inbox_access', JSON.stringify(await granted()) === JSON.stringify([bot, p1, p2, p3, quin, rae, mo].sort()), await granted());

  // A message the previous release moves through New.
  const conversation = (await q<{ id: string }>('INSERT INTO pm.conversations (inbox_id) VALUES ($1) RETURNING id', [inbox]))[0].id;
  const msg = (await q<{ id: string }>(`INSERT INTO pm.messages (inbox_id, thread_id, status, provider, provider_email_id, internet_message_id)
    VALUES ($1, $2, 'receiving', 'test', 'old-1', 'old-1@example.com') RETURNING id`, [inbox, conversation]))[0].id;

  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();

  const after = await granted();
  check('cleanup: the rows the copying made for people still in the group go', !after.includes(p1) && !after.includes(p2), after);
  check('cleanup: grants made for other reasons stay (a creator, older than the handler, a member handler, the primary)',
    [quin, rae, mo, bot].every((m) => after.includes(m)), after);
  check('cleanup: the row of someone who already left stays (it cannot be told apart)', after.includes(p3), after);
  const newcomer = await member('Nia');
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, newcomer]);
  check('copying stops: joining the group adds no grant', JSON.stringify(await granted()) === JSON.stringify(after));
  const other = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address) VALUES ('Sales', 'sales@agency.example') RETURNING id"))[0].id;
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id) VALUES ($1, $2)', [other, group]);
  check('copying stops: a new group handler adds no grant', (await q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1', [other])).length === 0);
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id) VALUES ($1, $2)', [other, mo]);
  check('a member handler still reads its inbox through a grant', (await q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [other, mo])).length === 1);

  // Derived access in the database.
  const reads = async (login: string, inboxId: string) => {
    await actAs(old, login);
    const [row] = (await old.query<{ ok: boolean }>('SELECT pm.can_read_inbox($1) AS ok', [inboxId])).rows;
    await old.exec('RESET ROLE');
    return row.ok;
  };
  check('db: a handler group\'s member reads the inbox with no grant', await reads(LOGINS.ana.id, inbox) && await reads(LOGINS.ana.id, other));
  await q('DELETE FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [group, p1]);
  check('db: leaving the group ends it', !(await reads(LOGINS.ana.id, inbox)) && !(await reads(LOGINS.ana.id, other)));
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, p1]);
  await q('DELETE FROM pm.inbox_handlers WHERE inbox_id = $1 AND handler_group_id = $2', [other, group]);
  check('db: the group no longer handling it ends it', await reads(LOGINS.ana.id, inbox) && !(await reads(LOGINS.ana.id, other)));
  await q('UPDATE pm.groups SET deleted_at = now() WHERE id = $1', [group]);
  check('db: a group in Trash gives none', !(await reads(LOGINS.ana.id, inbox)));
  await q('UPDATE pm.groups SET deleted_at = NULL WHERE id = $1', [group]);

  // The previous release's status writes are stamped.
  await q("UPDATE pm.messages SET status = 'new' WHERE id = $1", [msg]);
  const stamp = async () => { const at = (await q<{ requeued_at: Date | null }>('SELECT requeued_at FROM pm.messages WHERE id = $1', [msg]))[0].requeued_at; return at ? at.getTime() : null; };
  check('requeued: arriving is not a re-queue', await stamp() === null);
  await q("UPDATE pm.messages SET status = 'handled' WHERE id = $1", [msg]);
  check('requeued: leaving New stamps nothing', await stamp() === null);
  await q("UPDATE pm.messages SET status = 'new', reviewed_at = NULL WHERE id = $1", [msg]);
  const first = await stamp();
  check('requeued: going back to New (2.0.30\'s send back) is stamped', !!first);
  await q("UPDATE pm.messages SET requeued_at = now() + interval '1 day', subject = 'x' WHERE id = $1", [msg]);
  check('requeued: nobody writes it by hand, and other writes keep it', await stamp() === first);

  // Only an Owner changes the personal key lifetime.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'settings.manage', 'app', 'allow')", [admin]);
  await actAs(old, LOGINS.ben.id);
  const refused = await old.query('UPDATE pm.business_settings SET personal_key_lifetime_days = 30').then(() => null, (e: Error) => e.message);
  await actAs(old, LOGINS.owner.id);
  const allowed = await old.query('UPDATE pm.business_settings SET personal_key_lifetime_days = 30').then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  check('settings: an admin cannot change the personal key lifetime; an Owner can', /Only an Owner/.test(refused ?? '') && allowed === null, [refused, allowed]);
  check('settings: it is 1 to 3650 days or none', /personal_key_lifetime_days_check/.test(await old.query('UPDATE pm.business_settings SET personal_key_lifetime_days = 0').then(() => '', (e: Error) => e.message)));

  const fnGrants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = 'messages_stamp_requeued'`);
  check('grants: the stamp is the database\'s own', fnGrants.length === 1 && !fnGrants[0].anon && !fnGrants[0].auth, fnGrants);
  check('grants: the copying function is gone', (await q("SELECT 1 FROM pg_proc WHERE proname = 'group_members_grant_handled_inboxes'")).length === 0);
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q('UPDATE pm.workspace_modules SET enabled = true');
  await q("UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test'");
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const memberId = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase()}@agency.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    return memberId;
  };
  const allow = (memberId: string, keys: string[], channel: 'app' | 'api') => q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, $3, 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, keys, channel]);
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const ana = await member('Ana', 'member', LOGINS.ana);
  const ben = await member('Ben', 'member', LOGINS.ben);
  const cara = await member('Cara', 'member', LOGINS.cara);
  const planner = await member('Ashley', 'agent');
  const scout = await member('Scout', 'agent');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name, status) VALUES ('Happy Innovations', 'active') RETURNING id"))[0].id;
  for (const m of [ana, ben, cara, planner, scout]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  const inbox = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address, handler_member_id, triage_mode) VALUES ('Happy Innovations', 'hi@agency.example', $1, 'plans') RETURNING id", [planner]))[0].id;
  // Ana and Ben read the inbox (granted); Cara does not.
  for (const m of [ana, ben, cara]) await allow(m, ['inbound_email.read', 'inbound_email.triage', 'suggestions.manage'], 'app');
  await q('INSERT INTO pm.inbox_access (inbox_id, member_id, created_by) VALUES ($1, $2, $4), ($1, $3, $4)', [inbox, ana, ben, owner]);
  const AGENT = ['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal', 'tasks.read', 'tasks.create', 'projects.read', 'suggestions.create', 'suggestions.manage'];
  await allow(planner, AGENT, 'api');
  await allow(scout, [...AGENT, 'api_keys.manage_all'], 'api');
  for (const m of [ana, cara]) await allow(m, ['tasks.read', 'suggestions.manage', 'api_keys.manage_all'], 'api');
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [sha(secret), memberId, scopes]);
    return secret;
  };
  const keys = {
    planner: await key(planner, AGENT),
    scout: await key(scout, AGENT),
    scoutMint: await key(scout, ['tasks.read', 'api_keys.manage_all']),
    owner: await key(owner, ['tasks.read', 'api_keys.manage_all', 'suggestions.manage']),
    ana: await key(ana, ['tasks.read', 'suggestions.manage', 'api_keys.manage_all']),
    cara: await key(cara, ['tasks.read', 'suggestions.manage']),
  };
  return { q, owner, ana, ben, cara, planner, scout, project, inbox, keys };
}

let next = 500;
async function message(q: (sql: string, params?: unknown[]) => Promise<Loose[]>, inbox: string, fields: { minutesAgo: number; status: string }) {
  const conversation = id(next++);
  const received = new Date(Date.now() - fields.minutesAgo * 60_000).toISOString();
  await q('INSERT INTO pm.conversations (id, inbox_id, last_message_at) VALUES ($1, $2, $3)', [conversation, inbox, received]);
  const messageId = id(next++);
  await q(`INSERT INTO pm.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, received_at, subject, kind, auth, sender_verified, delivery, text_body)
    VALUES ($1, $2, $3, 'receiving', 'test', $5, $5, $4, 'Plan review', 'person', '{"trust":"trusted"}', true, 'direct', 'Please set it up.')`, [messageId, inbox, conversation, received, `m-${messageId}`]);
  // Arrives, then reaches the status asked for, as ingestion and triage do.
  await q("UPDATE pm.messages SET status = 'new', completed_at = now() WHERE id = $1", [messageId]);
  if (fields.status !== 'new') await q('UPDATE pm.messages SET status = $2 WHERE id = $1', [messageId, fields.status]);
  await q("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'from', 'jo@plan4thefuture.example')", [messageId]);
  return { conversation, message: messageId, received };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key', NEXT_PUBLIC_APP_URL: APP,
  });
  installSession(server.url);
  try {
    const signalRoute = await import('../src/app/api/v1/inbox/signal/route');
    const keysRoute = await import('../src/app/api/workspace/api-keys/route');
    const personalRoute = await import('../src/app/api/workspace/key-settings/personal/route');
    const v1Keys = await import('../src/app/api/v1/api-keys/route');
    const linkRoute = await import('../src/app/api/workspace/task-suggestions/[id]/link-email/route');
    const v1Approve = await import('../src/app/api/v1/task-suggestions/[id]/approve/route');
    const suggestionsRoute = await import('../src/app/api/v1/task-suggestions/route');
    const suggestionRoute = await import('../src/app/api/v1/task-suggestions/[id]/route');
    const inbox = await import('../src/lib/communications/inbox-service');
    const rules = await import('../src/lib/communications/inbox-rules');
    const { readableInboxIdsFor, inboxPeopleIds } = await import('../src/lib/communications/inbox-visibility');
    const { approveTaskSuggestion } = await import('../src/lib/supabase/queries');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const json = async (response: Response): Promise<Answer> => ({ status: response.status, body: await response.json().catch(() => null) });
    const as = (login: typeof signedIn) => { signedIn = login; };
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      json(await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      json(await handler(new Request(`${APP}${path}`, {
        method, headers: { 'content-type': 'application/json', origin: APP }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const tool = PM_TOOLS.find((t) => t.name === name)!;
      return outcomeResult(await tool.run(tool.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: APP }), { memberId }), tool.write) as Loose;
    };
    const ctx = async (memberId: string) => ({ service, access: (await resolveMemberAccess(service, memberId))!, memberId });

    // ── Wake signal ─────────────────────────────────────────────────────
    const signal = async () => (await v1(signalRoute.GET, 'GET', '/api/v1/inbox/signal', {}, s.keys.planner)).body?.data;
    const handled = await message(s.q, s.inbox, { minutesAgo: 120, status: 'handled' });
    const waiting = await message(s.q, s.inbox, { minutesAgo: 30, status: 'new' });
    const before = await signal();
    check('signal: every field as before, with plans_newest_queued_at after plans_newest_received_at',
      JSON.stringify(Object.keys(before ?? {})) === JSON.stringify(['new_count', 'newest_received_at', 'unsummarized_count', 'drafts_requested', 'waiting_count', 'plans_new_count', 'plans_newest_received_at', 'plans_newest_queued_at', 'shadow_pending_count']), before);
    check('signal: with nothing re-queued, the newest queued time is the newest arrival', before?.plans_new_count === 1
      && Date.parse(before.plans_newest_received_at) === Date.parse(waiting.received) && before.plans_newest_queued_at === before.plans_newest_received_at, before);

    const sent = await inbox.sendBackToAgent(await ctx(s.owner), handled.conversation, null);
    const [stamped] = await s.q<{ requeued_at: Date | null; received_at: Date }>('SELECT requeued_at, received_at FROM pm.messages WHERE id = $1', [sent.message_id]);
    check('send back: the message is stamped requeued_at, its received_at kept', !!stamped.requeued_at && ms(stamped.received_at) === ms(handled.received), stamped);
    const after = await signal();
    check('signal: an old message sent back moves plans_newest_queued_at past every received_at; plans_newest_received_at stays',
      after?.plans_new_count === 2 && Date.parse(after.plans_newest_received_at) === Date.parse(waiting.received)
        && ms(after.plans_newest_queued_at) === ms(stamped.requeued_at) && Date.parse(after.plans_newest_queued_at) > Date.parse(after.plans_newest_received_at), after);
    const tool = (await runTool(s.keys.planner, s.planner, 'get_inbox_signal', {}))?.structuredContent?.data;
    check('mcp: get_inbox_signal answers it too', !!tool?.plans_newest_queued_at && tool.plans_newest_queued_at === after?.plans_newest_queued_at && tool?.plans_newest_received_at === after?.plans_newest_received_at, tool);
    const none = await v1(signalRoute.GET, 'GET', '/api/v1/inbox/signal?handled=me', {}, s.keys.scout);
    check('signal: with no inboxes it answers null', none.status === 200 && 'plans_newest_queued_at' in none.body.data && none.body.data.plans_newest_queued_at === null, none.body);

    const asked = await message(s.q, s.inbox, { minutesAgo: 90, status: 'needs_human' });
    await s.q("INSERT INTO pm.triage (message_id, member_id, outcome, urgent, summary, question_for_human) VALUES ($1, $2, 'needs_human', false, 'Who owns it?', 'Who owns it?')", [asked.message, s.planner]);
    await inbox.answerAgentQuestion(await ctx(s.owner), asked.conversation, asked.message, 'Jo owns it.');
    const filtered = await message(s.q, s.inbox, { minutesAgo: 100, status: 'ignored' });
    await rules.moveToInbox(await ctx(s.owner), filtered.conversation, filtered.message);
    const stamps = await s.q<{ id: string; requeued_at: string | null }>('SELECT id, requeued_at FROM pm.messages WHERE id = ANY($1)', [[asked.message, filtered.message, waiting.message]]);
    const stampOf = (messageId: string) => stamps.find((r) => r.id === messageId)?.requeued_at ?? null;
    check('answer and move to Inbox: both are stamped; mail that never left New is not', !!stampOf(asked.message) && !!stampOf(filtered.message) && stampOf(waiting.message) === null, stamps);

    // ── Personal key expiry ─────────────────────────────────────────────
    as(LOGINS.ana);
    const mint = (body: Loose) => session(keysRoute.POST, 'POST', '/api/workspace/api-keys', {}, { name: 'Zapier', scopes: ['tasks.read'], ...body });
    const near = (iso: string | null | undefined, days: number) => !!iso && Math.abs(Date.parse(iso) - (Date.now() + days * DAY)) < 60_000;
    const thirty = await mint({ expires_in_days: 30 });
    const forever = await mint({ expires_in_days: null });
    const plain = await mint({});
    check('keys: a person picks 30 days, or no expiry; left out, no workspace default means none (as before)',
      near(thirty.body?.data?.key?.expires_at, 30) && forever.status === 200 && forever.body.data.key.expires_at === null && plain.body?.data?.key?.expires_at === null, [thirty.body, forever.body, plain.body]);
    const bad = await Promise.all([mint({ expires_in_days: 0 }), mint({ expires_in_days: 3651 }), mint({ expires_in_days: 1.5 })]);
    check('keys: 1 to 3650 whole days only', bad.every((b) => b.status === 422), bad.map((b) => b.body));

    const read = await session(personalRoute.GET, 'GET', '/api/workspace/key-settings/personal');
    const memberSet = await session(personalRoute.PATCH, 'PATCH', '/api/workspace/key-settings/personal', {}, { personal_key_lifetime_days: 30 });
    check('settings: a member reads the personal key lifetime and cannot change it', read.status === 200 && read.body.data.personal_key_lifetime_days === null
      && memberSet.status === 403 && memberSet.body.error.details.reason === 'owner_only', [read.body, memberSet.body]);
    as(LOGINS.owner);
    const ownerSet = await session(personalRoute.PATCH, 'PATCH', '/api/workspace/key-settings/personal', {}, { personal_key_lifetime_days: 90 });
    const ownerBad = await session(personalRoute.PATCH, 'PATCH', '/api/workspace/key-settings/personal', {}, { personal_key_lifetime_days: 0 });
    const audit = await s.q("SELECT after_snapshot FROM pm.api_audit_log WHERE endpoint = '/api/workspace/key-settings/personal'");
    check('settings: an Owner sets it (audited), 1 to 3650 days', ownerSet.status === 200 && ownerSet.body.data.personal_key_lifetime_days === 90 && ownerBad.status === 422
      && audit.length === 1 && audit[0].after_snapshot.personal_key_lifetime_days === 90, [ownerSet.body, ownerBad.body, audit]);
    as(LOGINS.ana);
    const defaulted = await mint({});
    const neverAsked = await mint({ expires_in_days: null });
    const longer = await mint({ expires_in_days: 365 });
    const shorter = await mint({ expires_in_days: 30 });
    check('keys: left out, a person\'s key takes the workspace\'s 90 days; a shorter choice stands', near(defaulted.body?.data?.key?.expires_at, 90) && near(shorter.body?.data?.key?.expires_at, 30), [defaulted.body, shorter.body]);
    check('keys: a non-Owner is refused no expiry, and capped at the workspace\'s 90 days', near(neverAsked.body?.data?.key?.expires_at, 90) && near(longer.body?.data?.key?.expires_at, 90), [neverAsked.body, longer.body]);
    as(LOGINS.owner);
    const ownerForever = await mint({ expires_in_days: null });
    const ownerYear = await mint({ expires_in_days: 365 });
    check('keys: an Owner may choose no expiry or longer', ownerForever.status === 200 && ownerForever.body.data.key.expires_at === null && near(ownerYear.body?.data?.key?.expires_at, 365), [ownerForever.body, ownerYear.body]);
    as(LOGINS.ana);
    check('settings: the member reads the new default', (await session(personalRoute.GET, 'GET', '/api/workspace/key-settings/personal')).body.data.personal_key_lifetime_days === 90);

    const v1Mint = (key: string, body: Loose) => v1(v1Keys.POST, 'POST', '/api/v1/api-keys', {}, key, { name: 'Script', scopes: ['tasks.read'], ...body });
    const own7 = await v1Mint(s.keys.ana, { member_id: s.ana, expires_in_days: 7 });
    const ownDefault = await v1Mint(s.keys.ana, { member_id: s.ana });
    await s.q('UPDATE pm.business_settings SET agent_key_lifetime_days = 30');
    const agentDefault = await v1Mint(s.keys.owner, { member_id: s.scout });
    const agentForever = await v1Mint(s.keys.owner, { member_id: s.scout, expires_in_days: null });
    const v1Bad = await v1Mint(s.keys.ana, { member_id: s.ana, expires_in_days: 0 });
    const v1Capped = await v1Mint(s.keys.ana, { member_id: s.ana, expires_in_days: null });
    // An agent's own key over the API (no Owner): its lifetime caps it, as the MCP create_api_key would.
    const agentOwnNever = await v1Mint(s.keys.scoutMint, { member_id: s.scout, expires_in_days: null });
    const agentOwnLong = await v1Mint(s.keys.scoutMint, { member_id: s.scout, expires_in_days: 400 });
    check('v1 keys: a non-Owner key is refused no expiry and capped, for a person\'s key and an agent\'s', near(v1Capped.body?.data?.key?.expires_at, 90)
      && near(agentOwnNever.body?.data?.key?.expires_at, 30) && near(agentOwnLong.body?.data?.key?.expires_at, 30), [v1Capped.body, agentOwnNever.body, agentOwnLong.body]);
    check('v1 keys: expires_in_days sets it; left out, the person\'s default or the agent\'s lifetime', own7.status === 201 && near(own7.body.data.key.expires_at, 7)
      && near(ownDefault.body?.data?.key?.expires_at, 90) && near(agentDefault.body?.data?.key?.expires_at, 30) && agentForever.body?.data?.key?.expires_at === null && v1Bad.status === 422,
    [own7.body, ownDefault.body, agentDefault.body, agentForever.body, v1Bad.status]);

    // ── An approved suggestion links its email ─────────────────────────
    const fromEmail = await message(s.q, s.inbox, { minutesAgo: 200, status: 'handled' });
    const suggestion = async (metadata: Loose) => (await s.q<{ id: string }>(`INSERT INTO pm.task_suggestions (project_id, proposed_by, title, description, reasoning, priority, status, metadata)
      VALUES ($1, $2, 'Set up the plan review', 'From the email', 'Asked for', 'medium', 'pending', $3) RETURNING id`, [s.project, s.planner, metadata]))[0].id;
    const link = (suggestionId: string) => session(linkRoute.POST, 'POST', `/api/workspace/task-suggestions/${suggestionId}/link-email`, { id: suggestionId });
    const linksOf = (messageId: string) => s.q<Loose>('SELECT task_id, relation, linked_by FROM pm.task_links WHERE message_id = $1', [messageId]);

    const s1 = await suggestion({ message_id: fromEmail.message });
    as(LOGINS.ana);
    check('link: nothing before it is approved', (await link(s1)).body?.data?.reason === 'not_approved');
    const approved = await approveTaskSuggestion(service, s1, {}, s.ana);
    as(LOGINS.ben);
    const notMine = await link(s1);
    check('link: only the approver links it (403 not_approver)', notMine.status === 403 && notMine.body.error.details.reason === 'not_approver', notMine.body);
    as(LOGINS.ana);
    const linked = await link(s1);
    const rows = await linksOf(fromEmail.message);
    const filed = await s.q('SELECT source FROM pm.conversation_projects WHERE conversation_id = $1 AND project_id = $2', [fromEmail.conversation, s.project]);
    check('link: the approver who reads the inbox links the email to the new task as created, filed as theirs',
      linked.status === 200 && linked.body.data.linked === true && rows.length === 1 && rows[0].task_id === approved.task.id && rows[0].relation === 'created'
        && rows[0].linked_by === s.ana && filed[0]?.source === 'person', [linked.body, rows, filed]);
    check('link: again changes nothing', (await link(s1)).status === 200 && (await linksOf(fromEmail.message)).length === 1);

    const otherEmail = await message(s.q, s.inbox, { minutesAgo: 210, status: 'handled' });
    const s2 = await suggestion({ message_id: otherEmail.message });
    await approveTaskSuggestion(service, s2, {}, s.cara);
    as(LOGINS.cara);
    const blind = await link(s2);
    check('link: an approver who cannot read the inbox links nothing (403 inbox_not_readable)', blind.status === 403 && blind.body.error.details.reason === 'inbox_not_readable'
      && (await linksOf(otherEmail.message)).length === 0, blind.body);
    const s3 = await suggestion({});
    await approveTaskSuggestion(service, s3, {}, s.cara);
    check('link: a suggestion with no email has nothing to link', (await link(s3)).body?.data?.reason === 'no_email');

    const v1Email = await message(s.q, s.inbox, { minutesAgo: 220, status: 'handled' });
    const s4 = await suggestion({ message_id: v1Email.message });
    const v1Approved = await v1(v1Approve.POST, 'POST', `/api/v1/task-suggestions/${s4}/approve`, { id: s4 }, s.keys.ana, {});
    const v1Links = await linksOf(v1Email.message);
    check('v1 approve: links the email too, its answer as before', v1Approved.status === 200 && JSON.stringify(Object.keys(v1Approved.body.data)) === '["suggestion","task"]'
      && v1Links.length === 1 && v1Links[0].task_id === v1Approved.body.data.task.id && v1Links[0].linked_by === s.ana, [v1Approved.body, v1Links]);
    const caraEmail = await message(s.q, s.inbox, { minutesAgo: 230, status: 'handled' });
    const s5 = await suggestion({ message_id: caraEmail.message });
    const caraApproved = await v1(v1Approve.POST, 'POST', `/api/v1/task-suggestions/${s5}/approve`, { id: s5 }, s.keys.cara, {});
    check('v1 approve: approved, unlinked, for a key whose member cannot read the inbox', caraApproved.status === 200 && (await linksOf(caraEmail.message)).length === 0, caraApproved.body);

    // An agent approver files the email only within its scope: out of it, the link is refused and logged, the approval stands.
    const agentEmail = await message(s.q, s.inbox, { minutesAgo: 240, status: 'handled' });
    const s6 = await suggestion({ message_id: agentEmail.message });
    const logged: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    let agentApproved: Answer;
    try {
      agentApproved = await v1(v1Approve.POST, 'POST', `/api/v1/task-suggestions/${s6}/approve`, { id: s6 }, s.keys.planner, {});
    } finally {
      console.error = consoleError;
    }
    check('v1 approve: an agent approver out of the email\'s scope gets the scope refusal, logged; the approval stands, unlinked',
      agentApproved.status === 200 && agentApproved.body.data.suggestion.status === 'approved' && (await linksOf(agentEmail.message)).length === 0
        && logged.some((args) => /EMAIL_PROJECT_OUT_OF_SCOPE/.test(JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a))))), [agentApproved.body, logged]);

    // ── A suggestion names only an email its key reads ─────────────────
    const goal = (await s.q<{ id: string }>("INSERT INTO pm.project_goals (project_id, title) VALUES ($1, 'Launch') RETURNING id", [s.project]))[0].id;
    const named = await message(s.q, s.inbox, { minutesAgo: 250, status: 'handled' });
    const propose = (key: string, metadata?: Loose) => v1(suggestionsRoute.POST, 'POST', '/api/v1/task-suggestions', {}, key, {
      project_id: s.project, goal_id: goal, title: 'Review the plan', description: 'From the email', reasoning: 'Asked for', ...(metadata === undefined ? {} : { metadata }),
    });
    const plainCreate = await propose(s.keys.scout);
    const readableCreate = await propose(s.keys.planner, { message_id: named.message, source: 'email' });
    check('suggestions: none named, or one the key reads, are created as before (201)', plainCreate.status === 201 && readableCreate.status === 201
      && readableCreate.body.data.metadata.message_id === named.message
      && JSON.stringify(Object.keys(plainCreate.body.data).sort()) === JSON.stringify(Object.keys(readableCreate.body.data).sort()), [plainCreate.body, readableCreate.body]);
    const blindCreate = await propose(s.keys.scout, { message_id: named.message });
    const junkCreate = await propose(s.keys.planner, { message_id: 'not-an-email' });
    const goneCreate = await propose(s.keys.planner, { message_id: randomUUID() });
    check('suggestions: an email the key cannot read is refused (422 message_not_readable), as is one that is not an email',
      [blindCreate, junkCreate, goneCreate].every((a) => a.status === 422 && a.body?.error?.details?.reason === 'message_not_readable'), [blindCreate.body, junkCreate.body, goneCreate.body]);
    const scoutOwn = String(plainCreate.body?.data?.id ?? randomUUID());
    const blindPatch = await v1(suggestionRoute.PATCH, 'PATCH', `/api/v1/task-suggestions/${scoutOwn}`, { id: scoutOwn }, s.keys.scout, { metadata: { message_id: named.message } });
    const keptId = String(readableCreate.body?.data?.id ?? randomUUID());
    const keptPatch = await v1(suggestionRoute.PATCH, 'PATCH', `/api/v1/task-suggestions/${keptId}`, { id: keptId }, s.keys.planner, { metadata: { message_id: named.message, note: 'x' } });
    check('suggestions: an edit cannot name an unreadable email either; one keeping its email saves', blindPatch.status === 422 && blindPatch.body?.error?.details?.reason === 'message_not_readable'
      && keptPatch.status === 200, [blindPatch.body, keptPatch.body]);

    // ── Group handlers: derived access in the app ──────────────────────
    const group = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Support', 'support') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3)', [group, s.cara, s.scout]);
    await s.q('INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id) VALUES ($1, $2)', [s.inbox, group]);
    const readable = async (memberId: string, channel: 'app' | 'api') => (await readableInboxIdsFor(service, memberId, (await resolveMemberAccess(service, memberId))!, channel)).includes(s.inbox);
    check('app: a handler group\'s person and agent read the inbox with no grant', await readable(s.cara, 'app') && await readable(s.scout, 'api')
      && (await s.q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = ANY($2)', [s.inbox, [s.cara, s.scout]])).length === 0);
    check('app: they are told when something in it waits on a person', (await inboxPeopleIds(service, s.inbox)).includes(s.cara));
    const scoutSignal = await v1(signalRoute.GET, 'GET', `/api/v1/inbox/signal?inbox_id=${s.inbox}`, {}, s.keys.scout);
    check('api: the group\'s agent polls the inbox', scoutSignal.status === 200 && scoutSignal.body.data.plans_new_count >= 1, scoutSignal.body);
    as(LOGINS.cara);
    check('link: once Cara reads the inbox through the group, her approval links', (await link(s2)).body?.data?.linked === true);
    await s.q('DELETE FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [group, s.scout]);
    const leftSignal = await v1(signalRoute.GET, 'GET', `/api/v1/inbox/signal?inbox_id=${s.inbox}`, {}, s.keys.scout);
    check('app: leaving the group ends it', !(await readable(s.scout, 'api')) && leftSignal.status !== 200, leftSignal);
    await s.q('UPDATE pm.groups SET deleted_at = now() WHERE id = $1', [group]);
    check('app: a group in Trash gives none', !(await readable(s.cara, 'app')) && !(await inboxPeopleIds(service, s.inbox)).includes(s.cara));
    await s.q('UPDATE pm.groups SET deleted_at = NULL WHERE id = $1', [group]);
    await s.q('DELETE FROM pm.inbox_handlers WHERE inbox_id = $1 AND handler_group_id = $2', [s.inbox, group]);
    check('app: the group no longer handling it ends it', !(await readable(s.cara, 'app')));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`Follow-ups: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`Follow-ups: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
