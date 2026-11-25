/**
 * The personal Assistant and the chat switchboard, end to end over the real
 * routes (session routes with a signed-in member, v1 routes with keys, the
 * public inbound route, MCP visibility, a fake PostgREST over PGlite with the
 * full schema, a stand-in for Supabase Auth, every chat provider call
 * mocked):
 * - The migration (20261124001400_assistant_chat.sql), run twice on the
 *   schema before it, matches schema.sql; assistants start off; the new
 *   tables and functions are the server's only.
 * - Preferences: the defaults, and how each switch and the tone read in the
 *   agent's context pack; a switch that is off refuses the write.
 * - My Assistant: a person sees only their own; the broken state and its
 *   admins told once; pause and resume (a pause by an admin is theirs).
 * - What it did, with undo (a task to Trash), never someone else's.
 * - "Sort my inbox": the assistant as handler of the person's own inbox,
 *   reaching that inbox only.
 * - Provisioning preview (dry run, writes nothing).
 * - Chat: Slack and Telegram signatures with real algorithms (and bad ones),
 *   Slack's challenge, an unknown sender's link prompt, inbound to identity
 *   to agent to webhook with an X-Act-For token, provider retries, the poll
 *   fallback, replies through the adapters, the rate limit.
 * - The live fleet's keys and tool lists are untouched.
 *
 *   npm run -s test:assistant-chat
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  assistantState, preferencesToContext, readSwitches, DEFAULT_PREFERENCES, DEFAULT_SWITCHES, KEY_GRACE_MS,
} from '../src/lib/assistant';
import { slackAdapter, slackSignature } from '../src/lib/chat/providers/slack';
import { telegramAdapter } from '../src/lib/chat/providers/telegram';
import { chatHttp } from '../src/lib/chat/providers/adapter';

const MIGRATION = '20261124001400_assistant_chat.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- ASSISTANT AND CHAT SWITCHBOARD (20261124001400_assistant_chat.sql)';
const APP_KEY = 'c'.repeat(64);
const SLACK_SECRET = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const SLACK_TOKEN = 'xoxb-1111-2222-abcdefghijklmnop';
const TELEGRAM_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

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
  owner: { id: '00000000-0000-4000-8000-00000000d001', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000d002', email: 'ana@example.com' },
  ben: { id: '00000000-0000-4000-8000-00000000d003', email: 'ben@example.com' },
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
  check('switches: missing or wrong values read as the defaults', JSON.stringify(readSwitches(null)) === JSON.stringify(DEFAULT_SWITCHES)
    && readSwitches({ create_tasks: false, sort_inbox: 'yes' }).create_tasks === false && readSwitches({ sort_inbox: 'yes' }).sort_inbox === false);
  check('switches: sort my inbox and remember start off, the rest on', !DEFAULT_SWITCHES.sort_inbox && DEFAULT_SWITCHES.create_tasks && DEFAULT_SWITCHES.draft_replies && DEFAULT_SWITCHES.remind_me && !DEFAULT_SWITCHES.remember);
  const on = preferencesToContext(DEFAULT_PREFERENCES, 'Ana').join('\n');
  check('context: the defaults in words', /warmly/.test(on) && /Sort my inbox is off/.test(on) && /Create tasks for me is on/.test(on) && /Remind me is on/.test(on), on);
  const off = preferencesToContext({ tone: 'brief', personality: 'No meetings on Fridays.', avatar_tone: 3, switches: { sort_inbox: true, create_tasks: false, draft_replies: false, remind_me: false, remember: false } }, 'Ana').join('\n');
  check('context: each switch off says what the app refuses; the tone and note are there', /Keep every message short/.test(off) && /No meetings on Fridays/.test(off)
    && /Sort my inbox is on: you handle Ana's own inbox/.test(off) && /never create tasks \(the app refuses them\)/.test(off)
    && /do not write reply drafts/.test(off) && /do not set reminders/.test(off), off);

  const base = { personId: 'p', createdAt: new Date(Date.now() - 3600_000).toISOString(), health: null };
  check('state: working with a key', assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1 }).state === 'working');
  check('state: paused by its person', assistantState({ ...base, status: 'suspended', suspendedBy: 'p', liveKeys: 1 }).state === 'paused');
  check('state: paused by an admin is broken', JSON.stringify(assistantState({ ...base, status: 'suspended', suspendedBy: 'o', liveKeys: 1 })) === JSON.stringify({ state: 'broken', reason: 'paused_by_admin' }));
  check('state: just made without a key is getting ready', assistantState({ ...base, createdAt: new Date(Date.now() - KEY_GRACE_MS / 2).toISOString(), status: 'active', suspendedBy: null, liveKeys: 0 }).state === 'getting_ready');
  check('state: no key past the grace period is broken', assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 0 }).reason === 'no_key');
  check('state: a host silent for three intervals is broken', assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1,
    health: { reportedAt: new Date(Date.now() - 4 * 60_000).toISOString(), intervalSeconds: 60 } }).reason === 'offline'
    && assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, health: { reportedAt: new Date(Date.now() - 60_000).toISOString(), intervalSeconds: 60 } }).state === 'working');
  const pausedAt = new Date().toISOString();
  check('state: every agent paused (the kill switch) is on hold, not working',
    JSON.stringify(assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, workspacePausedAt: pausedAt })) === JSON.stringify({ state: 'on_hold', reason: 'agents_paused' }));
  check('state: the agent paused on its own page is on hold',
    JSON.stringify(assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, agentPausedAt: pausedAt })) === JSON.stringify({ state: 'on_hold', reason: 'agent_paused' }));
  check('state: paused by its person stays theirs to resume, even with every agent paused',
    assistantState({ ...base, status: 'suspended', suspendedBy: 'p', liveKeys: 1, workspacePausedAt: pausedAt }).state === 'paused');

  // Slack's documented example: v0=HMAC-SHA256("v0:<ts>:<body>").
  const known = slackSignature('8f742231b10e8888abcd99yyyzzz85a5', '1531420618', 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c');
  check('slack: the signature matches Slack\'s documented example', known === 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503', known);
  const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1' });
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const headers = (signature: string, at = ts) => new Headers({ 'x-slack-request-timestamp': at, 'x-slack-signature': signature });
  const creds = { signing_secret: SLACK_SECRET, bot_token: SLACK_TOKEN };
  check('slack: a good signature verifies', slackAdapter.verify({ headers: headers(slackSignature(SLACK_SECRET, ts, body)), body, credentials: creds, now }));
  check('slack: a bad signature is refused', !slackAdapter.verify({ headers: headers(slackSignature('another-secret-00000000000000000', ts, body)), body, credentials: creds, now }));
  check('slack: a changed body is refused', !slackAdapter.verify({ headers: headers(slackSignature(SLACK_SECRET, ts, body)), body: `${body} `, credentials: creds, now }));
  const old = String(Math.floor(now / 1000) - 600);
  check('slack: a replay older than five minutes is refused', !slackAdapter.verify({ headers: headers(slackSignature(SLACK_SECRET, old, body), old), body, credentials: creds, now }));
  check('slack: the challenge is read', JSON.stringify(slackAdapter.parse(JSON.stringify({ type: 'url_verification', challenge: 'abc' }), new Headers())) === JSON.stringify({ kind: 'challenge', challenge: 'abc' }));
  const dm = slackAdapter.parse(JSON.stringify({ type: 'event_callback', event_id: 'Ev9', team_id: 'T1', event: { type: 'message', channel_type: 'im', user: 'U1', text: 'hello', channel: 'D1', ts: '1.1' } }), new Headers());
  check('slack: a direct message is read with its team and no thread', dm.kind === 'message' && dm.workspaceId === 'T1' && dm.threadId === null && dm.dedupeKey === 'Ev9' && dm.direct === true, dm);
  const mention = slackAdapter.parse(JSON.stringify({ type: 'event_callback', event_id: 'Ev10', team_id: 'T1', event: { type: 'app_mention', user: 'U1', text: '<@UBOT> hi there', channel: 'C1', ts: '2.2' } }), new Headers());
  check('slack: a mention is answered in its thread, without the mention', mention.kind === 'message' && mention.threadId === '2.2' && mention.text === 'hi there' && mention.direct === false, mention);
  check('slack: a bot\'s own message is ignored', slackAdapter.parse(JSON.stringify({ type: 'event_callback', event_id: 'Ev11', event: { type: 'message', channel_type: 'im', bot_id: 'B1', text: 'x', channel: 'D1' } }), new Headers()).kind === 'ignore');

  const tg = { bot_token: TELEGRAM_TOKEN, secret_token: 'a'.repeat(64) };
  check('telegram: the secret token verifies', telegramAdapter.verify({ headers: new Headers({ 'x-telegram-bot-api-secret-token': 'a'.repeat(64) }), body: '{}', credentials: tg }));
  check('telegram: a wrong or missing token is refused', !telegramAdapter.verify({ headers: new Headers({ 'x-telegram-bot-api-secret-token': 'b'.repeat(64) }), body: '{}', credentials: tg })
    && !telegramAdapter.verify({ headers: new Headers(), body: '{}', credentials: tg }));
  const start = telegramAdapter.parse(JSON.stringify({ update_id: 7, message: { message_id: 3, from: { id: 55, username: 'ana' }, chat: { id: 55, type: 'private' }, text: '/start' } }), new Headers());
  check('telegram: /start reads as hi, keyed by update_id', start.kind === 'message' && start.text === 'hi' && start.dedupeKey === 'update:7' && start.userHandle === '@ana' && start.direct === true, start);
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the assistant section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Workspace switch and name')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  await old.exec('RESET ROLE');
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();
  const settings = (await q<Loose>('SELECT assistants_enabled, assistant_label FROM pm.business_settings LIMIT 1'))[0];
  check('upgrade: assistants start off, unnamed', settings.assistants_enabled === false && settings.assistant_label === null, settings);
  const grants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('consume_chat_rate_limit', 'emit_assistant_message')`);
  check('grants: the new functions are the server\'s only', grants.length === 2 && grants.every((g: Loose) => !g.anon && !g.auth && g.svc), grants);
  const triggers = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('webhook_endpoints_assistant_guard', 'assistant_follow_personal_inbox')`);
  check('grants: the new trigger functions are nobody\'s to call', triggers.length === 2 && triggers.every((g: Loose) => !g.anon && !g.auth), triggers);
  const tables = await q<Loose>(`SELECT t AS name, has_table_privilege('authenticated', 'pm.' || t, 'SELECT') AS auth, has_table_privilege('anon', 'pm.' || t, 'SELECT') AS anon
    FROM unnest(ARRAY['assistant_preferences', 'chat_connections', 'chat_messages', 'chat_rate_limits']) AS t`);
  check('grants: the new tables are the server\'s only', tables.every((t: Loose) => !t.auth && !t.anon), tables);
  const plain = await old.query("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('slack', 'x', 'xoxb-plain')").then(() => null, (e: Error) => e.message);
  check('database: credentials are stored sealed only', /chat_connections_credentials_sealed/.test(plain ?? ''), plain);
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const TEMPLATE_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'reminders.manage_own', 'notifications.manage_own',
  'agent_activity.write', 'inbound_email.read', 'inbound_email.triage'];

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
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  const member = async (name: string, role: string, login?: { id: string; email: string }, extra: { delegateOf?: string } = {}) => {
    const email = login?.email ?? `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, email, role, extra.delegateOf ?? null, extra.delegateOf ? 'personal-assistant' : null]))[0].id;
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
  const anaAgent = await member("Ana's Assistant", 'agent', undefined, { delegateOf: ana });
  const benAgent = await member("Ben's Assistant", 'agent', undefined, { delegateOf: ben });
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Shared') RETURNING id"))[0].id;
  for (const m of [ana, ben, jeff]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  // Ben's alone: Ana cannot open it, so neither can her assistant.
  const secret = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Ben secret') RETURNING id"))[0].id;
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [secret, ben]);
  for (const m of [ana, ben]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny'), ($1, 'projects.read_all', 'app', 'deny') ON CONFLICT DO NOTHING", [m]);
  }
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]))[0].id;
    return { secret, id };
  };
  const keys = {
    jeff: await key(jeff, ['tasks.read', 'projects.read', 'tasks.create', 'notifications.manage_own']),
    anaAgent: await key(anaAgent, TEMPLATE_SCOPES),
    owner: await key(owner, ['webhooks.manage', 'projects.read']),
  };
  return { q, key, owner, ana, ben, jeff, anaAgent, benAgent, project, secret, keys };
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
  delete process.env.APP_ENCRYPTION_KEY;
  installSession(server.url);

  // Chat providers: every call is recorded and answered here; nothing leaves the machine.
  const providerCalls: { url: string; body: Loose }[] = [];
  let slackRefuses = false;
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    providerCalls.push({ url, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth.test')) return json({ ok: true, team_id: 'T1', team: 'Acme', user: 'assistant', user_id: 'UBOT' });
    if (url.endsWith('/chat.postMessage')) return json(slackRefuses ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: `${Date.now()}.0001` });
    if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 999, username: 'acme_assistant_bot', first_name: 'Acme' } });
    if (url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook')) return json({ ok: true, result: true });
    if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 42 } });
    return json({ ok: false, error: 'unknown_method' });
  };
  // Webhook deliveries to agents: caught here; everything else (the fake PostgREST) passes through.
  const deliveries: { url: string; headers: Headers; body: Loose }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://hooks.example.test')) {
      deliveries.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('ok', { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const assistantRoute = await import('../src/app/api/workspace/assistant/route');
    const activityRoute = await import('../src/app/api/workspace/assistant/activity/route');
    const undoRoute = await import('../src/app/api/workspace/assistant/undo/route');
    const settingsRoute = await import('../src/app/api/workspace/assistants/settings/route');
    const statusRoute = await import('../src/app/api/workspace/assistants/status/route');
    const setupsRoute = await import('../src/app/api/workspace/assistants/setups/route');
    const provisionRoute = await import('../src/app/api/workspace/assistants/provision/route');
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const connectionRoute = await import('../src/app/api/workspace/chat-connections/[id]/route');
    const inboundRoute = await import('../src/app/api/chat/inbound/[id]/route');
    const v1Messages = await import('../src/app/api/v1/assistant/messages/route');
    const v1Message = await import('../src/app/api/v1/assistant/messages/[id]/route');
    const v1Webhooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const v1Detail = await import('../src/app/api/v1/inbound-emails/[id]/route');
    const v1Context = await import('../src/app/api/v1/inbox/messages/[id]/context/route');
    const v1Plan = await import('../src/app/api/v1/inbox/messages/[id]/plan/route');
    const v1Rules = await import('../src/app/api/v1/inbox/sender-rules/route');
    const v1Draft = await import('../src/app/api/v1/inbox/reply-drafts/[id]/route');
    const v1Task = await import('../src/app/api/v1/tasks/[id]/route');
    const v1Reply = await import('../src/app/api/v1/assistant/messages/[id]/reply/route');
    const v1Handled = await import('../src/app/api/v1/assistant/messages/[id]/handled/route');
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Reminders = await import('../src/app/api/v1/reminders/route');
    const v1Projects = await import('../src/app/api/v1/projects/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { toolsFor } = await import('../src/lib/mcp/visibility');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { memberInboxIds } = await import('../src/lib/communications/agent-access');
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
    const inbound = async (connectionId: string, body: unknown, headers: Record<string, string>) => {
      const text = JSON.stringify(body);
      return read(await inboundRoute.POST(new Request(`https://pm.example.com/api/chat/inbound/${connectionId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text,
      }), { params: Promise.resolve({ id: connectionId }) }));
    };
    const slackSigned = (body: unknown, extra: Record<string, string> = {}, secret = SLACK_SECRET) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, JSON.stringify(body)), ...extra };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
    const jeffWorks = async (label: string) => {
      const answer = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.jeff.secret);
      check(`live fleet: Jeff's key works (${label})`, answer.status === 200, answer.status);
    };
    await jeffWorks('before');

    // ── The workspace switch ───────────────────────────────────────────
    as(LOGINS.ana);
    const anaOff = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('my assistant: while assistants are off, nobody has one to see', anaOff.status === 200 && anaOff.body.data.enabled === false && anaOff.body.data.assistant === null, anaOff.body);
    const anaEnables = await session(settingsRoute.PATCH, 'PATCH', '/api/workspace/assistants/settings', {}, { enabled: true });
    check('settings: a member cannot turn assistants on', anaEnables.status === 403 && reason(anaEnables) === 'owner_only', anaEnables.body);
    as(LOGINS.owner);
    const enabled = await session(settingsRoute.PATCH, 'PATCH', '/api/workspace/assistants/settings', {}, { enabled: true, label: 'Helper' });
    check('settings: an Owner turns them on and names them', enabled.status === 200 && enabled.body.data.enabled === true && enabled.body.data.label === 'Helper', enabled.body);

    // ── My Assistant: only your own ────────────────────────────────────
    as(LOGINS.ana);
    const anaView = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    const anaA = anaView.body?.data?.assistant;
    check('my assistant: Ana sees her own, under the workspace\'s name, working', anaView.status === 200 && anaView.body.data.label === 'Helper' && anaA?.id === s.anaAgent
      && anaA.state === 'working' && anaA.preferences.switches.sort_inbox === false && anaA.has_personal_inbox === false, anaView.body);
    check('my assistant: nothing about keys, scopes or templates reaches the page', !/scope|template|key_prefix|pk_live/.test(anaView.text), anaView.text.slice(0, 400));
    as(LOGINS.ben);
    const benView = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('my assistant: Ben sees his, never Ana\'s', benView.body?.data?.assistant?.id === s.benAgent, benView.body?.data?.assistant);

    // ── Broken, and the admin told once ────────────────────────────────
    await s.q("UPDATE pm.team_members SET created_at = now() - interval '2 hours' WHERE id = $1", [s.benAgent]);
    const benBroken = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    const told = await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1 AND entity_type = 'member' AND entity_id = $2", [s.owner, s.benAgent]);
    check('broken: no key after the grace period reads as paused, with why', benBroken.body?.data?.assistant?.state === 'broken' && benBroken.body.data.assistant.reason === 'no_key', benBroken.body?.data?.assistant);
    check('broken: the Owner is told (the person owns it, so the Owners hear)', told === 1, told);
    await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('broken: told once a day, not on every visit', await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1", [s.benAgent]) === 1);
    check('broken: Ben himself is not notified about his own assistant', await count('SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1', [s.ben]) === 0);
    const benKey = await s.key(s.benAgent, TEMPLATE_SCOPES);

    // ── Settings feed the context pack, and the guard ──────────────────
    as(LOGINS.ana);
    const saved = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, {
      name: 'Nova', tone: 'brief', personality: 'No meetings on Fridays.', avatar_tone: 4, switches: { create_tasks: false, remind_me: false },
    });
    check('settings: Ana renames hers and sets its tone, note, color and switches', saved.status === 200 && saved.body.data.assistant.name === 'Nova' && saved.body.data.assistant.avatar_tone === 4
      && saved.body.data.assistant.preferences.tone === 'brief' && saved.body.data.assistant.preferences.switches.create_tasks === false, saved.body);
    const pack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context', {}, s.keys.anaAgent.secret);
    const says = (pack.body?.data?.pack?.works_for?.preferences_say ?? []).join('\n');
    check('context: the agent reads her settings in its pack', pack.status === 200 && pack.body.data.pack.works_for.preferences.tone === 'brief'
      && /Create tasks for me is off/.test(says) && /No meetings on Fridays/.test(says) && /What Ana Lopez wants from you/.test(pack.body.data.markdown ?? ''), pack.body?.data?.pack?.works_for);
    const refusedTask = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.anaAgent.secret, { project_id: s.project, title: 'Should not exist' });
    check('guard: create tasks off refuses its task', refusedTask.status === 403 && reason(refusedTask) === 'assistant_switch_off' && refusedTask.body.error.details.switch === 'create_tasks', refusedTask.body);
    const refusedReminder = await v1(v1Reminders.POST, 'POST', '/api/v1/reminders', {}, s.keys.anaAgent.secret, { title: 'Call the bank' });
    check('guard: remind me off refuses its reminder', refusedReminder.status === 403 && reason(refusedReminder) === 'assistant_switch_off', refusedReminder.body);
    const jeffTask = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.jeff.secret, { project_id: s.project, title: 'Fleet work' });
    check('guard: the live fleet is never checked', jeffTask.status === 201, jeffTask.body);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { create_tasks: true } });
    const made = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.anaAgent.secret, { project_id: s.project, title: 'Book the venue' });
    check('guard: switched back on, it creates again', made.status === 201, made.body);

    // ── What it did, with undo ─────────────────────────────────────────
    const did = await session(activityRoute.GET, 'GET', '/api/workspace/assistant/activity');
    const createdItem = (did.body?.data?.items ?? []).find((item: Loose) => item.kind === 'task_created' && item.undo?.id === made.body?.data?.id);
    check('what it did: the task it created, with its undo', did.status === 200 && !!createdItem && /Book the venue/.test(createdItem.text), did.body?.data?.items);
    as(LOGINS.ben);
    const benUndo = await session(undoRoute.POST, 'POST', '/api/workspace/assistant/undo', {}, { kind: 'task_created', id: made.body?.data?.id });
    check('undo: someone else\'s assistant\'s work reads as missing', benUndo.status === 404, benUndo.body);
    as(LOGINS.ana);
    const undone = await session(undoRoute.POST, 'POST', '/api/workspace/assistant/undo', {}, { kind: 'task_created', id: made.body?.data?.id });
    const trashed = (await s.q<Loose>('SELECT deleted_at FROM pm.tasks WHERE id = $1', [made.body?.data?.id]))[0];
    check('undo: the task goes to Trash', undone.status === 200 && trashed?.deleted_at !== null, { body: undone.body, trashed });
    const didAgain = await session(activityRoute.GET, 'GET', '/api/workspace/assistant/activity');
    const after = (didAgain.body?.data?.items ?? []).find((item: Loose) => item.id === createdItem?.id);
    check('undo: the line says it is undone, with no second undo', after?.undone === true && after.undo === null, after);
    const jeffTaskUndo = await session(undoRoute.POST, 'POST', '/api/workspace/assistant/undo', {}, { kind: 'task_created', id: jeffTask.body?.data?.id });
    check('undo: a task another agent made is not hers to undo', jeffTaskUndo.status === 404, jeffTaskUndo.body);

    // ── Pause and resume ───────────────────────────────────────────────
    const paused = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: true });
    const pausedKey = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.anaAgent.secret);
    check('pause: Ana pauses hers; its key stops working', paused.body?.data?.assistant?.state === 'paused' && pausedKey.status !== 200, [paused.body?.data?.assistant?.state, pausedKey.status]);
    const resumed = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: false });
    check('pause: and resumes it', resumed.body?.data?.assistant?.state === 'working', resumed.body?.data?.assistant);

    // ── On hold: the kill switch, or the agent paused in Agents ────────
    const toldBefore = await count('SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1', [s.anaAgent]);
    await s.q('UPDATE pm.business_settings SET agents_paused_at = now(), agents_paused_by = $1', [s.owner]);
    const allHeld = (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant;
    await s.q('UPDATE pm.business_settings SET agents_paused_at = NULL, agents_paused_by = NULL');
    check('on hold: with every agent paused, hers reads on hold, not working', allHeld?.state === 'on_hold' && allHeld.reason === 'agents_paused', allHeld);
    await s.q('UPDATE pm.team_members SET agent_paused_at = now(), agent_paused_by = $2 WHERE id = $1', [s.anaAgent, s.owner]);
    const oneHeld = (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant;
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL, agent_paused_by = NULL WHERE id = $1', [s.anaAgent]);
    check('on hold: paused on its agent page, it reads on hold too', oneHeld?.state === 'on_hold' && oneHeld.reason === 'agent_paused', oneHeld);
    check('on hold: nobody is told it is broken', await count('SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1', [s.anaAgent]) === toldBefore);
    check('on hold: resumed, it works again', (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant?.state === 'working');

    // ── Sort my inbox ──────────────────────────────────────────────────
    const anaInbox = randomUUID();
    const sharedInbox = randomUUID();
    await s.q("INSERT INTO pm.inboxes (id, name, address, owner_member_id) VALUES ($1, 'Ana', 'ana-inbox@relay.example.com', $2)", [anaInbox, s.ana]);
    await s.q("INSERT INTO pm.inboxes (id, name, address) VALUES ($1, 'Billing', 'billing@relay.example.com')", [sharedInbox]);
    // An admin once granted the agent a shared inbox: a personal agent still never reaches it.
    await s.q('INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2)', [sharedInbox, s.anaAgent]);
    const sortOn = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { sort_inbox: true } });
    const handlerRows = await s.q<Loose>('SELECT inbox_id, is_primary FROM pm.inbox_handlers WHERE handler_member_id = $1', [s.anaAgent]);
    check('sort my inbox: on makes it a handler of her own inbox, never the primary', sortOn.body?.data?.assistant?.has_personal_inbox === true
      && handlerRows.length === 1 && handlerRows[0].inbox_id === anaInbox && handlerRows[0].is_primary === false, handlerRows);
    check('sort my inbox: and gives it access to that inbox', await count('SELECT count(*)::int AS n FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [anaInbox, s.anaAgent]) === 1);
    const agentAccess = await resolveMemberAccess(service, s.anaAgent);
    const reach = await memberInboxIds(service, s.anaAgent, agentAccess!);
    check('sort my inbox: it reaches her own inbox only, not the shared one it was once granted', JSON.stringify(reach) === JSON.stringify([anaInbox]), reach);
    const sortOff = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { sort_inbox: false } });
    check('sort my inbox: off takes both away', sortOff.status === 200
      && await count('SELECT count(*)::int AS n FROM pm.inbox_handlers WHERE handler_member_id = $1', [s.anaAgent]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [anaInbox, s.anaAgent]) === 0);

    // Inboxes made later follow the switch.
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { sort_inbox: true } });
    const laterInbox = randomUUID();
    await s.q("INSERT INTO pm.inboxes (id, name, address, owner_member_id) VALUES ($1, 'Ana two', 'ana-two@relay.example.com', $2)", [laterInbox, s.ana]);
    const covered = async (inbox: string, agent: string) => (await count('SELECT count(*)::int AS n FROM pm.inbox_handlers WHERE inbox_id = $1 AND handler_member_id = $2 AND NOT is_primary', [inbox, agent]))
      + (await count('SELECT count(*)::int AS n FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [inbox, agent]));
    check('sort my inbox: a personal inbox made for her later is covered at once', await covered(laterInbox, s.anaAgent) === 2);
    const handledInbox = randomUUID();
    await s.q("INSERT INTO pm.inboxes (id, name, address, owner_member_id, handler_member_id) VALUES ($1, 'Ana three', 'ana-three@relay.example.com', $2, $2)", [handledInbox, s.ana]);
    const handledRow = (await s.q<Loose>('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [handledInbox]))[0];
    check('sort my inbox: an inbox made with its own handler keeps it, and gains her assistant', handledRow?.handler_member_id === s.ana
      && await count('SELECT count(*)::int AS n FROM pm.inbox_handlers WHERE inbox_id = $1 AND handler_member_id = $2 AND is_primary', [handledInbox, s.ana]) === 1
      && await covered(handledInbox, s.anaAgent) === 2, handledRow);
    await s.q('UPDATE pm.inboxes SET owner_member_id = $1 WHERE id = $2', [s.ben, laterInbox]);
    check('sort my inbox: given to someone else, it leaves her assistant (and Ben\'s, switched off, gets nothing)',
      await covered(laterInbox, s.anaAgent) === 0 && await covered(laterInbox, s.benAgent) === 0);

    // ── Her inbox, within her reach ────────────────────────────────────
    const conversation = randomUUID();
    const mail = randomUUID();
    const benTask = randomUUID();
    await s.q(`INSERT INTO pm.conversations (id, inbox_id, subject_normalized, channel, project_id, project_source, last_message_at)
      VALUES ($1, $2, 'venue', 'email', $3, 'mapped', now())`, [conversation, anaInbox, s.secret]);
    await s.q("INSERT INTO pm.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'mapped'), ($1, $3, 'mapped')", [conversation, s.secret, s.project]);
    await s.q(`INSERT INTO pm.messages (id, inbox_id, thread_id, channel, status, provider, provider_email_id, internet_message_id, received_at, subject, kind, auth, text_body, new_text)
      VALUES ($1, $2, $3, 'email', 'new', 'test', $4, $4, now() - interval '10 minutes', 'Venue', 'person', '{"trust":"trusted"}', 'Can we book the venue?', 'Can we book the venue?')`, [mail, anaInbox, conversation, `m-${mail}`]);
    await s.q("INSERT INTO pm.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'domain')", [mail, s.secret]);
    await s.q("INSERT INTO pm.tasks (id, project_id, title, created_by) VALUES ($1, $2, 'Ben only plan', $3)", [benTask, s.secret, s.ben]);
    await s.q("INSERT INTO pm.task_links (message_id, task_id, relation, linked_by) VALUES ($1, $2, 'related', $3)", [mail, benTask, s.ben]);
    const detail = await v1(v1Detail.GET, 'GET', `/api/v1/inbound-emails/${mail}`, { id: mail }, s.keys.anaAgent.secret);
    const detailText = JSON.stringify(detail.body?.data ?? {});
    check('reach: the message detail drops every project Ana cannot open', detail.status === 200 && detail.body.data.project?.id !== s.secret
      && detail.body.data.projects.every((p: Loose) => p.id !== s.secret) && detail.body.data.projects.some((p: Loose) => p.id === s.project)
      && detail.body.data.candidates.length === 0 && detail.body.data.linked_tasks.length === 0 && !detailText.includes(s.secret) && !detailText.includes('Ben only plan'), { project: detail.body?.data?.project, projects: detail.body?.data?.projects, candidates: detail.body?.data?.candidates, linked: detail.body?.data?.linked_tasks });
    const context = await v1(v1Context.GET, 'GET', `/api/v1/inbox/messages/${mail}/context`, { id: mail }, s.keys.anaAgent.secret);
    const contextText = JSON.stringify(context.body?.data ?? {});
    check('reach: the triage context lists only her projects and their tasks', context.status === 200 && context.body.data.projects.length === 1
      && context.body.data.projects[0].id === s.project && !contextText.includes(s.secret) && !contextText.includes('Ben only plan'), context.body);

    // Sender rules: her inbox only.
    await s.q(`INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, created_by, scope, inbox_id) VALUES
      ('domain', 'vendor.example', 'newsletter', 'ignore', 'person', 'Everyone ignores these.', $1, 'workspace', NULL),
      ('domain', 'billing-only.example', 'newsletter', 'ignore', 'person', 'Billing inbox only.', $1, 'inbox', $2)`, [s.owner, sharedInbox]);
    const rules = await v1(v1Rules.GET, 'GET', '/api/v1/inbox/sender-rules', {}, s.keys.anaAgent.secret);
    const ruleValues = ((rules.body?.data ?? []) as Loose[]).map((rule) => rule.match_value);
    check('sender rules: her assistant reads only the rules that sort her inbox', rules.status === 200 && ruleValues.includes('vendor.example') && !ruleValues.includes('billing-only.example'), ruleValues);
    const ruleBody = { match_kind: 'domain', match_value: 'promo.example', topic: 'promotion', action: 'ignore', reason: 'Ana never reads these promotions.' };
    const workspaceRule = await v1(v1Rules.POST, 'POST', '/api/v1/inbox/sender-rules', {}, s.keys.anaAgent.secret, ruleBody);
    const workspaceScoped = await v1(v1Rules.POST, 'POST', '/api/v1/inbox/sender-rules', {}, s.keys.anaAgent.secret, { ...ruleBody, scope: 'workspace' });
    check('sender rules: her assistant cannot write a workspace rule', workspaceRule.status === 403 && reason(workspaceRule) === 'inbox_rule_only'
      && workspaceScoped.status === 403 && await count("SELECT count(*)::int AS n FROM pm.sender_rules WHERE match_value = 'promo.example'") === 0, [workspaceRule.body, workspaceScoped.body]);
    const sharedRule = await v1(v1Rules.POST, 'POST', '/api/v1/inbox/sender-rules', {}, s.keys.anaAgent.secret, { ...ruleBody, inbox_id: sharedInbox });
    check('sender rules: nor one for an inbox that is not hers', sharedRule.status === 403, sharedRule.body);
    const ownRule = await v1(v1Rules.POST, 'POST', '/api/v1/inbox/sender-rules', {}, s.keys.anaAgent.secret, { ...ruleBody, inbox_id: anaInbox });
    check('sender rules: one for her own inbox is fine', ownRule.status === 201 && ownRule.body.data.rule.inbox_id === anaInbox, ownRule.body);

    // Switches hold inside a triage plan, and for reply drafts.
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { create_tasks: false, remind_me: false } });
    const plan = await v1(v1Plan.POST, 'POST', `/api/v1/inbox/messages/${mail}/plan`, { id: mail }, s.keys.anaAgent.secret, {
      summary: 'Ana asks to book the venue.',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: s.project, title: 'Book the venue' },
        { type: 'add_reminder', intent: 'commitment', title: 'Check the venue booked', project_id: s.project },
      ],
    });
    const planReasons = ((plan.body?.error?.details?.items ?? []) as Loose[]).map((item) => item.reason);
    check('plan: switched-off items are problems, and nothing is applied', plan.status === 422 && planReasons.includes('assistant_switch_off_create_tasks')
      && planReasons.includes('assistant_switch_off_remind_me') && await count('SELECT count(*)::int AS n FROM pm.plans WHERE message_id = $1', [mail]) === 0
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Book the venue' AND deleted_at IS NULL") === 0, plan.body);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { create_tasks: true, remind_me: true, draft_replies: false } });
    const draftId = randomUUID();
    await s.q("INSERT INTO pm.reply_drafts (id, thread_id, message_id, requested_by) VALUES ($1, $2, $3, $4)", [draftId, conversation, mail, s.ana]);
    const draftOff = await v1(v1Draft.PUT, 'PUT', `/api/v1/inbox/reply-drafts/${draftId}`, { id: draftId }, s.keys.anaAgent.secret, { body: 'Yes, booked for Friday.' });
    check('drafts: draft replies off refuses its draft', draftOff.status === 403 && reason(draftOff) === 'assistant_switch_off' && draftOff.body.error.details.switch === 'draft_replies'
      && (await s.q<Loose>('SELECT status FROM pm.reply_drafts WHERE id = $1', [draftId]))[0].status === 'requested', draftOff.body);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { draft_replies: true } });
    const draftOn = await v1(v1Draft.PUT, 'PUT', `/api/v1/inbox/reply-drafts/${draftId}`, { id: draftId }, s.keys.anaAgent.secret, { body: 'Yes, booked for Friday.' });
    check('drafts: switched back on, it writes the draft for her own inbox', draftOn.status === 200
      && (await s.q<Loose>('SELECT status FROM pm.reply_drafts WHERE id = $1', [draftId]))[0].status === 'ready', draftOn.body);

    // Undo "Finished a task": only when the assistant itself moved it to done.
    const doneByIt = randomUUID();
    const doneByPerson = randomUUID();
    for (const [id, title] of [[doneByIt, 'Send the deck'], [doneByPerson, 'Call the caterer']]) {
      await s.q("INSERT INTO pm.tasks (id, project_id, title, created_by, created_at) VALUES ($1, $2, $3, $4, now() - interval '1 hour')", [id, s.project, title, s.ana]);
      await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, s.anaAgent]);
    }
    const finished = await v1(v1Task.PATCH, 'PATCH', `/api/v1/tasks/${doneByIt}`, { id: doneByIt }, s.keys.anaAgent.secret, { status: 'done' });
    const started = await v1(v1Task.PATCH, 'PATCH', `/api/v1/tasks/${doneByPerson}`, { id: doneByPerson }, s.keys.anaAgent.secret, { status: 'in_progress' });
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [doneByPerson]);
    const finishedList = await session(activityRoute.GET, 'GET', '/api/workspace/assistant/activity');
    const doneItems = ((finishedList.body?.data?.items ?? []) as Loose[]).filter((item) => item.kind === 'task_completed').map((item) => item.undo?.id);
    check('what it did: lists the task it finished, not one a person finished after it touched it', finished.status === 200 && started.status === 200
      && doneItems.includes(doneByIt) && !doneItems.includes(doneByPerson), { doneItems, finished: finished.status, started: started.status });
    const wrongUndo = await session(undoRoute.POST, 'POST', '/api/workspace/assistant/undo', {}, { kind: 'task_completed', id: doneByPerson });
    const rightUndo = await session(undoRoute.POST, 'POST', '/api/workspace/assistant/undo', {}, { kind: 'task_completed', id: doneByIt });
    check('undo: reopens only what the assistant finished', wrongUndo.status === 404 && rightUndo.status === 200
      && (await s.q<Loose>('SELECT status FROM pm.tasks WHERE id = $1', [doneByIt]))[0].status === 'todo'
      && (await s.q<Loose>('SELECT status FROM pm.tasks WHERE id = $1', [doneByPerson]))[0].status === 'done', [wrongUndo.body, rightUndo.body]);

    // ── Provisioning preview ───────────────────────────────────────────
    as(LOGINS.owner);
    await s.q("INSERT INTO pm.team_members (name, email, role) VALUES ('Cal New', 'cal@example.com', 'member')");
    const setup = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'member' });
    const before = await count('SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of IS NOT NULL');
    const preview = await session(provisionRoute.POST, 'POST', '/api/workspace/assistants/provision', {}, { dry_run: true });
    check('provision: the preview names only who is missing one, and writes nothing', setup.status === 201 && preview.status === 200 && preview.body.data.dry_run === true
      && preview.body.data.total_missing === 1 && preview.body.data.agents[0]?.person?.name === 'Cal New'
      && await count('SELECT count(*)::int AS n FROM pm.team_members WHERE delegate_of IS NOT NULL') === before, preview.body);

    // ── Chat connections ───────────────────────────────────────────────
    const noKey = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
    check('connections: without the encryption key nothing is saved', noKey.status === 422 && reason(noKey) === 'encryption_key_missing'
      && await count('SELECT count(*)::int AS n FROM pm.chat_connections') === 0, noKey.body);
    process.env.APP_ENCRYPTION_KEY = APP_KEY;
    as(LOGINS.ana);
    const memberAdds = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
    check('connections: a member cannot add one', memberAdds.status === 403, memberAdds.body);
    as(LOGINS.owner);
    const slack = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
    const slackId = slack.body?.data?.id as string;
    const stored = (await s.q<Loose>('SELECT credentials, external_workspace_id, bot_handle FROM pm.chat_connections WHERE id = $1', [slackId]))[0];
    check('connections: Slack is checked with auth.test and saved sealed, with its Request URL', slack.status === 201 && slack.body.data.inbound_url === `https://pm.example.com/api/chat/inbound/${slackId}`
      && stored?.credentials.startsWith('pm1:') && !stored.credentials.includes('xoxb') && stored.external_workspace_id === 'T1' && !slack.text.includes(SLACK_TOKEN), { body: slack.body, stored });
    const again = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
    check('connections: the same Slack workspace twice is 409', again.status === 409 && reason(again) === 'connection_exists', again.body);
    const telegram = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'telegram', bot_token: TELEGRAM_TOKEN });
    const telegramId = telegram.body?.data?.id as string;
    const hook = providerCalls.find((call) => call.url.endsWith('/setWebhook'));
    const telegramSecret = hook?.body?.secret_token as string;
    check('connections: Telegram gets its webhook set to this connection, with a secret token', telegram.status === 201 && telegram.body.data.bot_handle === '@acme_assistant_bot'
      && hook?.body?.url === `https://pm.example.com/api/chat/inbound/${telegramId}` && /^[a-f0-9]{64}$/.test(telegramSecret ?? ''), { body: telegram.body, hook });
    as(LOGINS.ana);
    const anaCards = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('my assistant: Ana sees both chats to connect, Telegram with a link that opens it', anaCards.body?.data?.connections?.length === 2
      && anaCards.body.data.connections.some((c: Loose) => c.provider === 'telegram' && c.open_url === 'https://t.me/acme_assistant_bot'), anaCards.body?.data?.connections);

    // ── Slack in ───────────────────────────────────────────────────────
    const challenge = { type: 'url_verification', challenge: 'chal-123', token: 'x' };
    const answeredChallenge = await inbound(slackId, challenge, slackSigned(challenge));
    check('slack: the URL challenge is answered once signed', answeredChallenge.status === 200 && answeredChallenge.body?.challenge === 'chal-123', answeredChallenge.body);
    const forged = await inbound(slackId, challenge, slackSigned(challenge, {}, 'wrongwrongwrongwrongwrongwrong12'));
    check('slack: a bad signature is 401, before anything is read', forged.status === 401, forged.body);
    const unknownConnection = await inbound(randomUUID(), challenge, slackSigned(challenge));
    const noAdapter = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('teams', 'Teams', 'pm1:x') RETURNING id"))[0].id;
    const unreadable = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('slack', 'Broken', 'pm1:garbage') RETURNING id"))[0].id;
    const noAdapterIn = await inbound(noAdapter, challenge, slackSigned(challenge));
    const unreadableIn = await inbound(unreadable, challenge, slackSigned(challenge));
    check('inbound: an unknown connection, no adapter, unreadable credentials and a bad signature all answer the same 401',
      [unknownConnection, noAdapterIn, unreadableIn, forged].every((answer) => answer.status === 401 && answer.text === forged.text), [unknownConnection.text, noAdapterIn.text, unreadableIn.text, forged.text]);

    const event = (id: string, user: string, text: string, channel = 'D_ANA') => ({
      type: 'event_callback', team_id: 'T1', event_id: id, event: { type: 'message', channel_type: 'im', user, text, channel, ts: `${Date.now() / 1000}` },
    });
    providerCalls.length = 0;
    const stranger = event('EvStranger1', 'U_STRANGER', 'hi', 'D_STRANGER');
    const strangerIn = await inbound(slackId, stranger, slackSigned(stranger));
    const prompt = providerCalls.find((call) => call.url.endsWith('/chat.postMessage'));
    check('unknown sender: recorded as unrouted, answered with a one-time link to connect', strangerIn.status === 200 && strangerIn.body.status === 'unrouted'
      && prompt?.body?.channel === 'D_STRANGER' && /https:\/\/pm\.example\.com\/link\/pl_[a-f0-9]{64}/.test(prompt.body.text)
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE provider = 'slack' AND external_id = 'U_STRANGER' AND workspace_id = 'T1'") === 1, { body: strangerIn.body, prompt });
    providerCalls.length = 0;
    const stranger2 = event('EvStranger2', 'U_STRANGER', 'hello?', 'D_STRANGER');
    await inbound(slackId, stranger2, slackSigned(stranger2));
    check('unknown sender: a second message within the hour gets a reminder, not a second link', /sent you a link/.test(providerCalls[0]?.body?.text ?? '')
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 1, providerCalls);
    await s.q("UPDATE pm.identity_link_requests SET created_at = now() - interval '5 minutes' WHERE external_id = 'U_STRANGER'");
    const stranger2b = event('EvStranger2b', 'U_STRANGER', 'hello again?', 'D_STRANGER');
    await inbound(slackId, stranger2b, slackSigned(stranger2b));
    check('unknown sender: minutes later, still no second link (one an hour)', await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 1);
    await s.q("UPDATE pm.identity_link_requests SET created_at = now() - interval '61 minutes' WHERE external_id = 'U_STRANGER'");
    const stranger3 = event('EvStranger3', 'U_STRANGER', 'still me', 'D_STRANGER');
    await inbound(slackId, stranger3, slackSigned(stranger3));
    check('unknown sender: an hour later, a fresh link', await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 2);
    providerCalls.length = 0;
    const inChannel = { type: 'event_callback', team_id: 'T1', event_id: 'EvChannel1', event: { type: 'app_mention', user: 'U_OTHER', text: '<@UBOT> hi', channel: 'C_TEAM', ts: '5.5' } };
    const inChannelIn = await inbound(slackId, inChannel, slackSigned(inChannel));
    check('unknown sender: in a shared channel, no link, just "message me directly"', inChannelIn.body?.status === 'unrouted'
      && providerCalls[0]?.body?.text === 'Message me directly to connect your account.' && !/\/link\//.test(JSON.stringify(providerCalls))
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_OTHER'") === 0, providerCalls);
    const otherTeam = { ...event('EvOtherTeam', 'U_STRANGER', 'hi', 'D_STRANGER'), team_id: 'T2' };
    const otherTeamIn = await inbound(slackId, otherTeam, slackSigned(otherTeam));
    check('slack: an event from another workspace is ignored', otherTeamIn.status === 200 && otherTeamIn.body.reason === 'other_workspace'
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE dedupe_key = 'EvOtherTeam'") === 0, otherTeamIn.body);
    // A Slack account linked with no workspace never stands in for this workspace's.
    await s.q("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'slack', 'U_NOWS', now(), 'admin')", [s.ben]);
    const noWorkspace = event('EvNoWs', 'U_NOWS', 'hi', 'D_NOWS');
    const noWorkspaceIn = await inbound(slackId, noWorkspace, slackSigned(noWorkspace));
    check('slack: an identity without a workspace is not this workspace\'s sender', noWorkspaceIn.body?.status === 'unrouted'
      && (await s.q<Loose>("SELECT member_id FROM pm.chat_messages WHERE dedupe_key = 'EvNoWs'"))[0]?.member_id === null, noWorkspaceIn.body);

    await s.q("INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES ($1, 'slack', 'U_ANA', 'T1', now(), 'admin')", [s.ana]);
    // Chat is private: assistant.message only on an endpoint filtered to a personal agent.
    const unfilteredSql = await db.query(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Everything', 'https://hooks.example.test/all', 'whsec_all', '{assistant.message}')`)
      .then(() => null, (e: Error) => e.message);
    check('endpoints: the database refuses assistant.message without a personal agent filter', /filtered to a personal agent/.test(unfilteredSql ?? ''), unfilteredSql);
    const toFleet = await db.query(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id) VALUES ('Jeff', 'https://hooks.example.test/jeff', 'whsec_j', '{assistant.message}', $1)`, [s.jeff])
      .then(() => null, (e: Error) => e.message);
    check('endpoints: nor filtered to a shared agent', /filtered to a personal agent/.test(toFleet ?? ''), toFleet);
    const unfilteredApi = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, { name: 'All chat', url: 'https://hooks.example.test/all', events: ['assistant.message'] });
    check('endpoints: the API says why, 422', unfilteredApi.status === 422 && reason(unfilteredApi) === 'assistant_message_needs_personal_agent', unfilteredApi.body);
    // One that slipped in before the guard (triggers off for the insert) still never hears anyone's chat.
    await s.q('ALTER TABLE pm.webhook_endpoints DISABLE TRIGGER webhook_endpoints_assistant_guard');
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Old catch-all', 'https://hooks.example.test/catchall', 'whsec_old', '{assistant.message}')`);
    await s.q('ALTER TABLE pm.webhook_endpoints ENABLE TRIGGER webhook_endpoints_assistant_guard');
    const endpointId = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id)
      VALUES ('Nova harness', 'https://hooks.example.test/nova', 'whsec_nova_test_secret', '{assistant.message}', $1) RETURNING id`, [s.anaAgent]))[0].id;
    const tokensBefore = await count('SELECT count(*)::int AS n FROM pm.delegation_tokens');
    const fromAna = event('EvAna1', 'U_ANA', 'Can you move my 3pm to Friday?');
    const anaIn = await inbound(slackId, fromAna, slackSigned(fromAna));
    const messageId = anaIn.body?.id as string;
    const row = (await s.q<Loose>('SELECT status, member_id, agent_id, identity_id, conversation_id, text FROM pm.chat_messages WHERE id = $1', [messageId]))[0];
    check('inbound: a linked person\'s message is recorded for their assistant and sent to its webhook', anaIn.status === 200 && anaIn.body.status === 'notified'
      && row?.member_id === s.ana && row.agent_id === s.anaAgent && row.status === 'notified' && row.conversation_id === 'D_ANA', { body: anaIn.body, row });
    const evt = (await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'assistant.message' AND resource_id = $1", [messageId]))[0]?.payload;
    check('webhook: assistant.message carries ids, the person, the thread ids and where to read and reply', evt?.data?.message?.id === messageId
      && evt.data.person.id === s.ana && Array.isArray(evt.data.thread_ids) && evt.data.read.path === `/api/v1/assistant/messages/${messageId}`
      && evt.data.reply.path === `/api/v1/assistant/messages/${messageId}/reply` && JSON.stringify(evt.data.member_ids) === JSON.stringify([s.anaAgent]), evt);
    check('webhook: never the chat text, and no act-for token', !JSON.stringify(evt ?? {}).includes('move my 3pm') && !('act_for' in (evt?.data ?? {})) && !('text' in (evt?.data?.message ?? {}))
      && await count('SELECT count(*)::int AS n FROM pm.delegation_tokens') === tokensBefore, evt);
    const readOne = await v1(v1Message.GET, 'GET', `/api/v1/assistant/messages/${messageId}`, { id: messageId }, s.keys.anaAgent.secret);
    check('read: her assistant reads the text with its own key', readOne.status === 200 && readOne.body.data.text === 'Can you move my 3pm to Friday?' && readOne.headers.get('cache-control') === 'no-store', readOne.body);
    await settle();
    const delivered = deliveries.find((delivery) => delivery.url === 'https://hooks.example.test/nova');
    check('webhook: delivered to the assistant\'s endpoint, signed', delivered?.headers.get('x-vm-event-type') === 'assistant.message' && !!delivered.headers.get('x-vm-signature')
      && delivered.body?.data?.message?.id === messageId, delivered ? { headers: [...delivered.headers.entries()] } : deliveries.length);
    check('webhook: an endpoint without the agent\'s filter never gets it', !deliveries.some((delivery) => delivery.url.includes('catchall'))
      && await count("SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_endpoints e ON e.id = d.endpoint_id WHERE e.name = 'Old catch-all'") === 0);
    const retry = await inbound(slackId, fromAna, slackSigned(fromAna, { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' }));
    check('inbound: Slack\'s retry is a no-op', retry.status === 200 && retry.body.status === 'duplicate'
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE dedupe_key = 'EvAna1'") === 1
      && await count("SELECT count(*)::int AS n FROM pm.webhook_events WHERE event_type = 'assistant.message'") === 1, retry.body);
    void endpointId;

    // ── Telegram in, and the poll ──────────────────────────────────────
    await s.q("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'telegram', '5550001', now(), 'link')", [s.ben]);
    const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, from: { id: 5550001, username: 'benode' }, chat: { id: 5550001, type: 'private' }, text } });
    const badSecret = await inbound(telegramId, update(100, 'hi'), { 'x-telegram-bot-api-secret-token': 'f'.repeat(64) });
    check('telegram: a wrong secret token is 401', badSecret.status === 401, badSecret.body);
    // One stranger in a group cannot flood the bot: twenty a minute, then 429; others still get through.
    const flood = (id: number, from: number) => ({ update_id: id, message: { message_id: id, from: { id: from }, chat: { id: -100, type: 'group' }, text: 'spam' } });
    const floodAnswers: number[] = [];
    for (let i = 0; i < 21; i++) floodAnswers.push((await inbound(telegramId, flood(5000 + i, 666), { 'x-telegram-bot-api-secret-token': telegramSecret })).status);
    const someoneElse = await inbound(telegramId, flood(6000, 777), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('rate limit: one sender gets twenty a minute, then 429; another sender is unaffected', floodAnswers.slice(0, 20).every((status) => status === 200)
      && floodAnswers[20] === 429 && someoneElse.status === 200, { floodAnswers, other: someoneElse.status });
    const benIn = await inbound(telegramId, update(101, 'What is on my plate today?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('poll: with no webhook endpoint, the message waits for the assistant', benIn.status === 200 && benIn.body.status === 'pending', benIn.body);
    const benRetry = await inbound(telegramId, update(101, 'What is on my plate today?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('telegram: a retried update_id is a no-op', benRetry.body?.status === 'duplicate' && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE dedupe_key = 'update:101'") === 1, benRetry.body);
    const polled = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages?status=pending', {}, benKey.secret);
    check('poll: Ben\'s assistant fetches it, with its text and the thread, and no act-for token', polled.status === 200 && polled.body.data.messages.length === 1
      && polled.body.data.messages[0].text === 'What is on my plate today?' && polled.body.data.messages[0].provider === 'telegram'
      && Array.isArray(polled.body.data.messages[0].thread) && !('act_for' in polled.body.data) && polled.headers.get('cache-control') === 'no-store', polled.body);
    const benReadsAna = await v1(v1Message.GET, 'GET', `/api/v1/assistant/messages/${messageId}`, { id: messageId }, benKey.secret);
    check('read: another assistant cannot read it', benReadsAna.status === 404, benReadsAna.body);
    const anaPending = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages', {}, s.keys.anaAgent.secret);
    const anaNotified = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages?status=notified', {}, s.keys.anaAgent.secret);
    check('poll: each assistant sees only its own; a webhooked message is not pending', anaPending.body?.data?.messages?.length === 0 && anaNotified.body?.data?.messages?.length === 1
      && anaNotified.body.data.messages[0].id === messageId, [anaPending.body, anaNotified.body?.data?.messages?.length]);
    const jeffPoll = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages', {}, s.keys.jeff.secret);
    check('poll: a shared agent has no chat of its own', jeffPoll.status === 403 && reason(jeffPoll) === 'not_a_personal_agent', jeffPoll.body);
    const badStatus = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages?status=nope', {}, benKey.secret);
    check('poll: an unknown status is refused', badStatus.status === 400, badStatus.body);

    // ── Replies through the adapters ───────────────────────────────────
    providerCalls.length = 0;
    const reply = await v1(v1Reply.POST, 'POST', `/api/v1/assistant/messages/${messageId}/reply`, { id: messageId }, s.keys.anaAgent.secret, { text: 'Done: moved to Friday 3pm.' });
    const sent = providerCalls.find((call) => call.url.endsWith('/chat.postMessage'));
    check('reply: sent to Slack in the conversation it came from, with the bot token', reply.status === 201 && sent?.body?.channel === 'D_ANA' && sent.body.text === 'Done: moved to Friday 3pm.'
      && (await s.q<Loose>('SELECT status FROM pm.chat_messages WHERE id = $1', [messageId]))[0].status === 'replied'
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE reply_to_id = $1 AND direction = 'outbound' AND status = 'sent' AND agent_id = $2", [messageId, s.anaAgent]) === 1, { reply: reply.body, sent });
    const benReplies = await v1(v1Reply.POST, 'POST', `/api/v1/assistant/messages/${messageId}/reply`, { id: messageId }, benKey.secret, { text: 'Not mine' });
    check('reply: another assistant cannot answer it', benReplies.status === 404, benReplies.body);
    slackRefuses = true;
    const refused = await v1(v1Reply.POST, 'POST', `/api/v1/assistant/messages/${messageId}/reply`, { id: messageId }, s.keys.anaAgent.secret, { text: 'Again' });
    slackRefuses = false;
    check('reply: a provider refusal is 502 with its reason, recorded as failed', refused.status === 502 && reason(refused) === 'provider_refused' && refused.body.error.details.code === 'channel_not_found'
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE reply_to_id = $1 AND status = 'failed'", [messageId]) === 1, refused.body);
    const benMessage = (polled.body?.data?.messages?.[0]?.id as string | undefined) ?? randomUUID();
    const tool = PM_TOOLS.find((t) => t.name === 'reply_in_chat')!;
    providerCalls.length = 0;
    const viaTool = outcomeResult(await tool.run(tool.input.parse({ message_id: benMessage, text: 'Two meetings and a review.' }) as Record<string, unknown>,
      routeCaller({ key: benKey.secret, origin: 'http://localhost' }), { memberId: s.benAgent }), tool.write).structuredContent as Loose;
    const tgSent = providerCalls.find((call) => call.url.endsWith('/sendMessage'));
    check('mcp: reply_in_chat answers on Telegram', viaTool?.ok === true && tgSent?.body?.chat_id === '5550001' && tgSent.body.text === 'Two meetings and a review.'
      && tgSent.url.includes(`/bot${TELEGRAM_TOKEN}/`), { viaTool, tgSent });
    const benIn2 = await inbound(telegramId, update(102, 'thanks'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    const handled = await v1(v1Handled.POST, 'POST', `/api/v1/assistant/messages/${benIn2.body?.id}/handled`, { id: benIn2.body?.id }, benKey.secret);
    const pendingAfter = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages', {}, benKey.secret);
    check('handled: marked without a reply, it leaves the pending list', handled.status === 200 && handled.body.data.status === 'handled' && pendingAfter.body?.data?.messages?.length === 0, [handled.body, pendingAfter.body]);
    const threaded = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages?status=all', {}, benKey.secret);
    const last = threaded.body?.data?.messages?.find((m: Loose) => m.id === benIn2.body?.id);
    check('thread: a later message carries what was said before, both ways', last?.thread?.length === 2 && last.thread[0].direction === 'inbound' && last.thread[1].direction === 'outbound', last?.thread);

    // ── MCP visibility ─────────────────────────────────────────────────
    const anaAccess = await resolveMemberAccess(service, s.anaAgent);
    const jeffAccess = await resolveMemberAccess(service, s.jeff);
    const anaTools = toolsFor({ access: anaAccess!, scopes: TEMPLATE_SCOPES, readOnly: false, profile: 'generic' }).map((t) => t.name);
    const jeffTools = toolsFor({ access: jeffAccess!, scopes: ['tasks.read', 'projects.read', 'tasks.create', 'notifications.manage_own'], readOnly: false, profile: 'generic' }).map((t) => t.name);
    check('mcp: a personal assistant sees the chat tools', ['list_chat_messages', 'reply_in_chat', 'mark_chat_handled'].every((n) => anaTools.includes(n)), anaTools);
    check('mcp: the live fleet\'s tool list is unchanged', !jeffTools.some((n) => /chat/.test(n)), jeffTools);

    // ── Rate limit ─────────────────────────────────────────────────────
    const quiet = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('custom', 'Quiet', 'pm1:x') RETURNING id"))[0].id;
    const limits: boolean[] = [];
    for (let i = 0; i < 3; i++) limits.push((await s.q<Loose>("SELECT * FROM pm.consume_chat_rate_limit($1, '', 2, 60)", [quiet]))[0]?.allowed);
    check('rate limit: per connection, the third in the window is refused', JSON.stringify(limits) === JSON.stringify([true, true, false]), limits);
    const other = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('custom', 'Other', 'pm1:y') RETURNING id"))[0].id;
    check('rate limit: each connection has its own window', (await s.q<Loose>("SELECT * FROM pm.consume_chat_rate_limit($1, '', 2, 60)", [other]))[0]?.allowed === true);
    const senderA = (await s.q<Loose>("SELECT * FROM pm.consume_chat_rate_limit($1, 'user:A', 1, 60)", [other]))[0]?.allowed;
    const senderA2 = (await s.q<Loose>("SELECT * FROM pm.consume_chat_rate_limit($1, 'user:A', 1, 60)", [other]))[0]?.allowed;
    const senderB = (await s.q<Loose>("SELECT * FROM pm.consume_chat_rate_limit($1, 'user:B', 1, 60)", [other]))[0]?.allowed;
    check('rate limit: each sender has a window of their own', senderA === true && senderA2 === false && senderB === true, [senderA, senderA2, senderB]);

    // ── Paused by an admin ─────────────────────────────────────────────
    await s.q("UPDATE pm.team_members SET status = 'suspended', suspended_by = $1, suspended_at = now() WHERE id = $2", [s.owner, s.benAgent]);
    as(LOGINS.ben);
    const benResume = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: false });
    check('admin pause: Ben cannot resume what an admin paused', benResume.status === 403 && reason(benResume) === 'paused_by_admin', benResume.body);
    providerCalls.length = 0;
    const toPaused = await inbound(telegramId, update(103, 'hello?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('admin pause: chat gets the plain line, nothing reaches the assistant', toPaused.body?.status === 'unrouted'
      && providerCalls.some((call) => call.body?.text === 'Your assistant is paused. Your admin has been told.'), [toPaused.body, providerCalls]);

    // ── Status list ────────────────────────────────────────────────────
    const memberStatus = await session(statusRoute.GET, 'GET', '/api/workspace/assistants/status');
    check('status: a member cannot list everyone\'s', memberStatus.status === 403, memberStatus.body);
    as(LOGINS.owner);
    const status = await session(statusRoute.GET, 'GET', '/api/workspace/assistants/status');
    const rows = status.body?.data?.assistants ?? [];
    check('status: the Owner sees each with its state, broken first', status.status === 200 && rows[0]?.id === s.benAgent && rows[0].state === 'broken' && rows[0].reason === 'paused_by_admin'
      && rows.some((r: Loose) => r.id === s.anaAgent && r.state === 'working'), rows);

    // ── Removing a connection ──────────────────────────────────────────
    providerCalls.length = 0;
    const removed = await session(connectionRoute.DELETE, 'DELETE', `/api/workspace/chat-connections/${telegramId}`, { id: telegramId });
    check('connections: removing Telegram deletes its webhook and its chat history', removed.status === 200 && providerCalls.some((call) => call.url.endsWith('/deleteWebhook'))
      && await count('SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1', [telegramId]) === 0, removed.body);
    check('logs: no token was ever written to the audit log', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE request_body::text LIKE '%xoxb%' OR request_body::text LIKE '%AAHdq%'") === 0);
    await jeffWorks('at the end');
  } finally {
    globalThis.fetch = realFetch;
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
