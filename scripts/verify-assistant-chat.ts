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
 * - Assistant fixes (20261127000100): assistants off is a hold (the page
 *   keeps the assistant and its controls, its writes answer 423); a pause by
 *   an admin is a hold with no alert; chat lines say why and who fixes it;
 *   messages sent while paused reach the assistant on resume (the newest
 *   20); a chat connection's honest status (waiting, connected, not
 *   receiving); a token or signing secret replaced in place keeps history;
 *   one connection per provider and kind; a stranger's link names nobody and
 *   a fresh one comes once the last expired.
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
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  assistantState, assistantStateSince, preferencesToContext, readSwitches, DEFAULT_PREFERENCES, DEFAULT_SWITCHES, KEY_GRACE_MS,
} from '../src/lib/assistant';
import { chatConnectionHealth } from '../src/lib/chat/types';
import { quietWords } from '../src/lib/chat/inbound';
import { slackAdapter, slackSignature } from '../src/lib/chat/providers/slack';
import { telegramAdapter } from '../src/lib/chat/providers/telegram';
import { chatHttp } from '../src/lib/chat/providers/adapter';
import { webhookTransport } from '../src/lib/webhooks/target';

const MIGRATION = '20261124001400_assistant_chat.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- ASSISTANT AND CHAT SWITCHBOARD (20261124001400_assistant_chat.sql)';
const SCOPE_MIGRATION = '20261125000900_webhook_setup_scope.sql';
const SCOPE_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', SCOPE_MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCOPE_SECTION = '-- WEBHOOK SETUP SCOPE (20261125000900_webhook_setup_scope.sql)';
const FIXES_MIGRATION = '20261127000100_assistant_fixes.sql';
const FIXES_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', FIXES_MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const FIXES_SECTION = '-- ASSISTANT FIXES (20261127000100_assistant_fixes.sql)';
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
  check('state: paused by an admin is a hold with its own reason, not broken', JSON.stringify(assistantState({ ...base, status: 'suspended', suspendedBy: 'o', liveKeys: 1 })) === JSON.stringify({ state: 'on_hold', reason: 'paused_by_admin' }));
  check('state: an admin pause never reads host down (its keys stop with it)', JSON.stringify(assistantState({ ...base, status: 'suspended', suspendedBy: 'o', liveKeys: 0,
    health: { reportedAt: new Date(Date.now() - 3600_000).toISOString(), intervalSeconds: 60 } })) === JSON.stringify({ state: 'on_hold', reason: 'paused_by_admin' }));
  check('state: assistants off is a hold', JSON.stringify(assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, assistantsOff: true })) === JSON.stringify({ state: 'on_hold', reason: 'assistants_off' }));
  check('state: its person\'s pause still wins over assistants off', assistantState({ ...base, status: 'suspended', suspendedBy: 'p', liveKeys: 1, assistantsOff: true }).state === 'paused');
  check('state: a key that ran out or was revoked says so, not "never connected"', assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 0, lastKeyAt: new Date(Date.now() - 86400_000).toISOString() }).reason === 'key_lapsed');
  const lapsed = { state: 'broken', reason: 'key_lapsed' } as const;
  check('chat line: not working says why, and an admin was told only when one was',
    quietWords(lapsed, 'Nova', 'Assistant', 'https://x/assistant', 'admin') === "Nova can't answer right now: its key expired or was revoked. Your admin has been told."
      && quietWords(lapsed, 'Nova', 'Assistant', 'https://x/assistant', 'settings') === "Nova can't answer right now: its key expired or was revoked. Fix it in AI > Setup.",
    quietWords(lapsed, 'Nova', 'Assistant', 'https://x/assistant', 'settings'));
  check('chat line: an admin pause reads as a hold that ends, not as broken', quietWords({ state: 'on_hold', reason: 'paused_by_admin' }, 'Nova', 'Assistant', 'u') === 'Nova was paused by an admin. It will pick up what you sent when they resume it.');
  const conn = { enabled: true, kind: 'personal' as const, agents: [] };
  const recent = new Date(Date.now() - 3600_000).toISOString();
  check('chat status: nothing verified yet is waiting, a recent message is connected, an old one is quiet',
    chatConnectionHealth({ ...conn, last_inbound_at: null, last_refused_at: null }) === 'waiting'
      && chatConnectionHealth({ ...conn, last_inbound_at: recent, last_refused_at: null }) === 'connected'
      && chatConnectionHealth({ ...conn, last_inbound_at: new Date(Date.now() - 30 * 86400_000).toISOString(), last_refused_at: null }) === 'quiet');
  check('chat status: a refusal after the last verified request is not receiving; one before it is not',
    chatConnectionHealth({ ...conn, last_inbound_at: null, last_refused_at: recent }) === 'not_receiving'
      && chatConnectionHealth({ ...conn, last_inbound_at: new Date().toISOString(), last_refused_at: recent }) === 'connected'
      && chatConnectionHealth({ ...conn, enabled: false, last_inbound_at: null, last_refused_at: recent }) === 'off');
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
  const silent = { reportedAt: new Date(Date.now() - 4 * 60_000).toISOString(), intervalSeconds: 60 };
  const beating = { reportedAt: new Date(Date.now() - 60_000).toISOString(), intervalSeconds: 60 };
  const deadHold = assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, health: silent, workspacePausedAt: pausedAt });
  check('state: on hold with a host silent past the offline rule says its host is down',
    JSON.stringify(deadHold) === JSON.stringify({ state: 'on_hold', reason: 'agents_paused', hostDown: true }), deadHold);
  check('state: on hold with a beating host does not',
    JSON.stringify(assistantState({ ...base, status: 'active', suspendedBy: null, liveKeys: 1, health: beating, agentPausedAt: pausedAt })) === JSON.stringify({ state: 'on_hold', reason: 'agent_paused' }));
  const sinceInput = { ...base, status: 'active', suspendedBy: null, liveKeys: 1, workspacePausedAt: pausedAt };
  const offlineInput = { ...base, status: 'active', suspendedBy: null, liveKeys: 1, health: silent };
  const noKeyInput = { ...base, status: 'active', suspendedBy: null, liveKeys: 0, lastKeyAt: '2026-11-01T00:00:00Z' };
  check('since: a hold begins when it was paused, offline at the last report, no key after the newest key',
    assistantStateSince(sinceInput, assistantState(sinceInput)) === pausedAt
    && assistantStateSince(offlineInput, assistantState(offlineInput)) === silent.reportedAt
    && assistantStateSince(noKeyInput, assistantState(noKeyInput)) === '2026-11-01T00:00:00Z');

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
  // Top level, so no thread yet: an answer starts one on the message itself (its ts, replyTo).
  check('slack: a mention is read without the mention, with who was mentioned and its own ts', mention.kind === 'message' && mention.threadId === null && mention.messageId === '2.2'
    && mention.text === 'hi there' && mention.direct === false && JSON.stringify(mention.mentions) === '["UBOT"]', mention);
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
  await setupScopeMigrationChecks();
  await fixesMigrationChecks();
}

/** 20261127000100: mirrored in schema.sql, safe twice on the schema before it, its new function the server's only, the gate answers assistants_off. */
async function fixesMigrationChecks() {
  const at = SCHEMA_SQL.indexOf(FIXES_SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const body = FIXES_SQL.slice(FIXES_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- One gate')).trim();
  check('schema.sql: the assistant fixes section mirrors its migration', at > 0 && SCHEMA_SQL.slice(at).includes(body));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  await applyMigrationsFrom(old, FIXES_MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the assistant fixes migration, run twice, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const grants = await q<Loose>(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('set_chat_connection_agents', 'api_request_gate')`);
  check('grants: set_chat_connection_agents and the gate are the server\'s only', grants.length === 2 && grants.every((g: Loose) => !g.anon && !g.auth && g.svc), grants);
  await old.exec('RESET ROLE');
  await old.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const personal = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, delegate_of) VALUES ('Pat''s Assistant', 'pat.a@example.com', 'agent', $1) RETURNING id", [person]))[0].id;
  const shared = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Ops', 'ops@example.com', 'agent') RETURNING id"))[0].id;
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  const gate = async (member: string) => {
    const key = (await q<{ id: string }>("INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions) VALUES ('k', 'pk_live', md5(random()::text), $1, $1, '{}', 'scoped') RETURNING id", [member]))[0].id;
    await actAs(old, null);
    const answer = (await old.query<{ g: Loose }>('SELECT pm.api_request_gate($1, $2) AS g', [key, member])).rows[0].g;
    await old.exec('RESET ROLE');
    return answer;
  };
  await q('UPDATE pm.business_settings SET assistants_enabled = false');
  const offPersonal = await gate(personal);
  const offShared = await gate(shared);
  const offPerson = await gate(person);
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  const onPersonal = await gate(personal);
  check('gate: assistants off holds a personal agent only, never a company agent or a person', offPersonal?.assistants_off === true && offShared?.assistants_off === false
    && offPerson?.assistants_off === false && onPersonal?.assistants_off === false, { offPersonal, offShared, offPerson, onPersonal });
  await old.close();
}

/** 20261125000900: mirrored in schema.sql, safe twice, fills in the setup of agents made before, locked down. */
async function setupScopeMigrationChecks() {
  const at = SCHEMA_SQL.indexOf(SCOPE_SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const body = SCOPE_SQL.slice(SCOPE_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Columns')).trim();
  check('schema.sql: the setup scope section mirrors its migration', at > 0 && SCHEMA_SQL.slice(at).includes(body));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  await old.exec('RESET ROLE');
  await old.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const setup = (await q<{ id: string }>("INSERT INTO pm.assistant_setups (match_role, template_key) VALUES ('member', 'personal-assistant') RETURNING id"))[0].id;
  const agent = (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template)
    VALUES ('Pat''s Assistant', 'pat.assistant@example.com', 'agent', $1, 'personal-assistant') RETURNING id`, [person]))[0].id;
  const handMade = (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template)
    VALUES ('Pat''s Reporter', 'pat.reporter@example.com', 'agent', $1, 'weekly-reporter') RETURNING id`, [person]))[0].id;
  await applyMigrationsFrom(old, SCOPE_MIGRATION);
  const after = await q<Loose>('SELECT id, assistant_setup_id FROM pm.team_members WHERE id = ANY($1::uuid[])', [[agent, handMade]]);
  check('upgrade: a personal agent made before records the setup that matches it; one from no setup stays without',
    after.find((row) => row.id === agent)?.assistant_setup_id === setup && after.find((row) => row.id === handMade)?.assistant_setup_id === null, after);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the setup scope migration, run twice, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();
  const grants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('assistant_setup_for', 'team_members_assistant_setup_guard')`);
  check('grants: the setup scope functions are nobody\'s but the server\'s', grants.length === 2 && grants.every((g: Loose) => !g.anon && !g.auth), grants);
  const indexes = (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'pm' AND tablename = 'webhook_endpoints'")).map((row) => row.indexname);
  check('fan-out: active endpoints are looked up by event type through an index', indexes.includes('idx_webhook_endpoints_active_events'), indexes);
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
  let slackTeam = 'T1';
  let telegramBotId = 999;
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    providerCalls.push({ url, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth.test')) return json({ ok: true, team_id: slackTeam, team: 'Acme', user: 'assistant', user_id: 'UBOT' });
    if (url.endsWith('/chat.postMessage')) return json(slackRefuses ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: `${Date.now()}.0001` });
    if (url.endsWith('/getMe')) return json({ ok: true, result: { id: telegramBotId, username: 'acme_assistant_bot', first_name: 'Acme' } });
    if (url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook')) return json({ ok: true, result: true });
    if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 42 } });
    return json({ ok: false, error: 'unknown_method' });
  };
  // Webhook deliveries to agents: hooks.example.test resolves to a public
  // address here and every send is caught; nothing leaves the machine.
  const deliveries: { url: string; headers: Headers; body: Loose }[] = [];
  const realFetch = globalThis.fetch;
  const realTransport = { ...webhookTransport };
  webhookTransport.lookup = async (host) => (host === 'hooks.example.test' ? [{ address: '93.184.215.14', family: 4 }] : realTransport.lookup(host));
  webhookTransport.post = async (target, init) => {
    deliveries.push({ url: target.url.toString(), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return { status: 200, text: 'ok' };
  };

  try {
    const assistantRoute = await import('../src/app/api/workspace/assistant/route');
    const activityRoute = await import('../src/app/api/workspace/assistant/activity/route');
    const undoRoute = await import('../src/app/api/workspace/assistant/undo/route');
    const settingsRoute = await import('../src/app/api/workspace/assistants/settings/route');
    const statusRoute = await import('../src/app/api/workspace/assistants/status/route');
    const setupsRoute = await import('../src/app/api/workspace/assistants/setups/route');
    const setupRoute = await import('../src/app/api/workspace/assistants/setups/[id]/route');
    const { runDispatch } = await import('../src/lib/webhooks/dispatch');
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
    const v1Drafts = await import('../src/app/api/v1/inbox/reply-drafts/route');
    const askDraftRoute = await import('../src/app/api/workspace/inbox/threads/[id]/draft/route');
    const threadRoute = await import('../src/app/api/workspace/inbox/threads/[id]/route');
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
    check('assistants off: her page keeps hers, on hold because assistants are off, never a 403', anaOff.status === 200 && anaOff.body.data.enabled === false
      && anaOff.body.data.assistant?.id === s.anaAgent && anaOff.body.data.assistant.state === 'on_hold' && anaOff.body.data.assistant.reason === 'assistants_off', anaOff.body);
    const offActivity = await session(activityRoute.GET, 'GET', '/api/workspace/assistant/activity');
    const offPause = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: true });
    const offResume = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: false });
    check('assistants off: she keeps her controls (what it did, Pause and Resume)', offActivity.status === 200 && offPause.body?.data?.assistant?.state === 'paused'
      && offResume.body?.data?.assistant?.state === 'on_hold', [offActivity.status, offPause.body, offResume.body?.data?.assistant]);
    const offWrite = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.anaAgent.secret, { project_id: s.project, title: 'While assistants are off' });
    check('assistants off: its writes stop, 423 assistants_off', offWrite.status === 423 && reason(offWrite) === 'assistants_off', offWrite.body);
    const offRead = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.anaAgent.secret);
    check('assistants off: it still reads', offRead.status === 200, offRead.body);
    const offFleet = await v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, s.keys.jeff.secret, { project_id: s.project, title: 'Fleet work while assistants are off' });
    check('assistants off: a company agent is not held', offFleet.status === 201, offFleet.body);
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
    check('broken: his page reads not working, and that an admin was told (one was)', benBroken.body?.data?.assistant?.fixer === 'admin', benBroken.body?.data?.assistant);
    const toldLink = (await s.q<Loose>("SELECT title, link FROM pm.team_member_notifications WHERE user_id = $1 AND entity_id = $2", [s.owner, s.benAgent]))[0];
    check('broken: the Owner\'s bell opens the agent service step, and says not working', toldLink?.link === '/ai?tab=setup#assistant-service' && /not working/.test(toldLink?.title ?? ''), toldLink);
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

    // Her personal inbox has no handler of its own: a draft she asks for goes to her assistant.
    const asked = await session(askDraftRoute.POST, 'POST', `/api/workspace/inbox/threads/${conversation}/draft`, { id: conversation }, { instructions: 'Say yes.' });
    const waitingFor = await v1(v1Drafts.GET, 'GET', '/api/v1/inbox/reply-drafts', {}, s.keys.anaAgent.secret);
    check('drafts: asked on her own inbox, the draft goes to her assistant', asked.status === 201 && asked.body?.data?.status === 'requested'
      && ((waitingFor.body?.data ?? []) as Loose[]).some((row) => row.id === asked.body.data.id), [asked.body, waitingFor.body]);
    const shown = await session(threadRoute.GET, 'GET', `/api/workspace/inbox/threads/${conversation}`, { id: conversation });
    check('drafts: the thread names her assistant as the one who writes it', shown.body?.data?.reply_drafter?.id === s.anaAgent, shown.body?.data?.reply_drafter);
    await s.q("UPDATE pm.reply_drafts SET status = 'failed', completed_at = now() WHERE thread_id = $1 AND status = 'requested'", [conversation]);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { sort_inbox: false } });
    const unshared = await session(askDraftRoute.POST, 'POST', `/api/workspace/inbox/threads/${conversation}/draft`, { id: conversation }, {});
    check('drafts: with Sort my inbox off, it says how to let her assistant in', unshared.status === 409 && /Sort my inbox/.test(JSON.stringify(unshared.body)), unshared.body);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { switches: { sort_inbox: true } });
    await s.q('UPDATE pm.business_settings SET assistants_enabled = false');
    const assistantsOff = await session(askDraftRoute.POST, 'POST', `/api/workspace/inbox/threads/${conversation}/draft`, { id: conversation }, {});
    const hidden = await session(threadRoute.GET, 'GET', `/api/workspace/inbox/threads/${conversation}`, { id: conversation });
    await s.q('UPDATE pm.business_settings SET assistants_enabled = true');
    check('drafts: with assistants off, no agent writes it (409) and the thread offers none', assistantsOff.status === 409 && /no agent/.test(JSON.stringify(assistantsOff.body))
      && hidden.body?.data?.reply_drafter === null, [assistantsOff.body, hidden.body?.data?.reply_drafter]);

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
    check('connections: the same Slack workspace twice is 409', again.status === 409 && ['connection_exists', 'slot_taken'].includes(reason(again)), again.body);
    const telegram = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'telegram', bot_token: TELEGRAM_TOKEN });
    const telegramId = telegram.body?.data?.id as string;
    const hook = providerCalls.find((call) => call.url.endsWith('/setWebhook'));
    const telegramSecret = hook?.body?.secret_token as string;
    check('connections: Telegram gets its webhook set to this connection, with a secret token', telegram.status === 201 && telegram.body.data.bot_handle === '@acme_assistant_bot'
      && hook?.body?.url === `https://pm.example.com/api/chat/inbound/${telegramId}` && /^[a-f0-9]{64}$/.test(telegramSecret ?? ''), { body: telegram.body, hook });
    const callsBefore = providerCalls.length;
    const secondTelegram = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'telegram', bot_token: '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ' });
    check('slots: a second personal Telegram bot is refused by the server, before the provider is called', secondTelegram.status === 409 && reason(secondTelegram) === 'slot_taken'
      && providerCalls.length === callsBefore && await count("SELECT count(*)::int AS n FROM pm.chat_connections WHERE provider = 'telegram'") === 1, secondTelegram.body);
    const health = async (id: string) => {
      const listed = await session(connectionsRoute.GET, 'GET', '/api/workspace/chat-connections');
      const row = (listed.body?.data?.connections ?? []).find((c: Loose) => c.id === id);
      return row ? chatConnectionHealth(row) : null;
    };
    check('honest status: a new Slack connection waits for Slack, not "Connected"', await health(slackId) === 'waiting');
    as(LOGINS.ana);
    const anaCards = await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('my assistant: Ana sees both chats to connect, Telegram with a link that opens it', anaCards.body?.data?.connections?.length === 2
      && anaCards.body.data.connections.some((c: Loose) => c.provider === 'telegram' && c.open_url === 'https://t.me/acme_assistant_bot'), anaCards.body?.data?.connections);

    // ── Slack in ───────────────────────────────────────────────────────
    const challenge = { type: 'url_verification', challenge: 'chal-123', token: 'x' };
    const answeredChallenge = await inbound(slackId, challenge, slackSigned(challenge));
    check('slack: the URL challenge is answered once signed', answeredChallenge.status === 200 && answeredChallenge.body?.challenge === 'chal-123', answeredChallenge.body);
    as(LOGINS.owner);
    check('honest status: Slack\'s signed URL check counts as heard: connected', await health(slackId) === 'connected');
    const forged = await inbound(slackId, challenge, slackSigned(challenge, {}, 'wrongwrongwrongwrongwrongwrong12'));
    check('slack: a bad signature is 401, before anything is read', forged.status === 401, forged.body);
    check('honest status: a request that fails the signing check reads not receiving', await health(slackId) === 'not_receiving'
      && (await s.q<Loose>('SELECT last_refused_at FROM pm.chat_connections WHERE id = $1', [slackId]))[0]?.last_refused_at !== null);
    await inbound(slackId, challenge, slackSigned(challenge));
    check('honest status: a verified request after it is connected again', await health(slackId) === 'connected');
    as(LOGINS.ana);
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
    check('link page: a link the person started from chat names nobody as its requester', await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER' AND requested_by IS NULL AND requested_by_key_id IS NULL") === 1);
    const linkToken = /\/link\/(pl_[a-f0-9]{64})/.exec(prompt?.body?.text ?? '')?.[1] ?? '';
    const linkRoute = await import('../src/app/api/workspace/identities/link/[token]/route');
    const linkView = await session(linkRoute.GET, 'GET', `/api/workspace/identities/link/${linkToken}`, { token: linkToken });
    check('link page: it reads "you messaged the bot", never that the Owner asked', linkView.status === 200 && linkView.body?.data?.from_chat === true && linkView.body.data.requested_by_name === null, linkView.body);
    providerCalls.length = 0;
    const stranger2 = event('EvStranger2', 'U_STRANGER', 'hello?', 'D_STRANGER');
    await inbound(slackId, stranger2, slackSigned(stranger2));
    check('unknown sender: a second message within the hour gets a reminder, not a second link', /sent you a link/.test(providerCalls[0]?.body?.text ?? '')
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 1, providerCalls);
    await s.q("UPDATE pm.identity_link_requests SET created_at = now() - interval '5 minutes' WHERE external_id = 'U_STRANGER'");
    const stranger2b = event('EvStranger2b', 'U_STRANGER', 'hello again?', 'D_STRANGER');
    await inbound(slackId, stranger2b, slackSigned(stranger2b));
    check('unknown sender: minutes later, still no second link (one an hour)', await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 1);
    // The link expired after 15 minutes: the next message gets a fresh one at once, no hour's wait.
    await s.q("UPDATE pm.identity_link_requests SET created_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' WHERE external_id = 'U_STRANGER'");
    providerCalls.length = 0;
    const stranger3 = event('EvStranger3', 'U_STRANGER', 'still me', 'D_STRANGER');
    await inbound(slackId, stranger3, slackSigned(stranger3));
    check('unknown sender: once the link expired, a fresh one at once', await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 2
      && /\/link\/pl_/.test(providerCalls[0]?.body?.text ?? ''), providerCalls);
    providerCalls.length = 0;
    const inChannel = { type: 'event_callback', team_id: 'T1', event_id: 'EvChannel1', event: { type: 'app_mention', user: 'U_OTHER', text: '<@UBOT> hi', channel: 'C_TEAM', ts: '5.5' } };
    const inChannelIn = await inbound(slackId, inChannel, slackSigned(inChannel));
    // The personal bot answers DMs only (company chat: verify-company-chat.ts).
    check('personal bot: a channel mention is ignored, never recorded or answered', inChannelIn.body?.status === 'ignored' && inChannelIn.body?.reason === 'personal_dm_only'
      && providerCalls.length === 0 && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE dedupe_key = 'EvChannel1'") === 0
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_OTHER'") === 0, { body: inChannelIn.body, providerCalls });
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
    const toldBeforePause = await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1", [s.benAgent]);
    as(LOGINS.ben);
    const benPausedView = (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant;
    check('admin pause: his page reads on hold, paused by an admin, not broken', benPausedView?.state === 'on_hold' && benPausedView.reason === 'paused_by_admin', benPausedView);
    const benResume = await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: false });
    check('admin pause: Ben cannot resume what an admin paused', benResume.status === 403 && reason(benResume) === 'paused_by_admin', benResume.body);
    providerCalls.length = 0;
    const toPaused = await inbound(telegramId, update(103, 'hello?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('admin pause: chat says it is paused by an admin and gets the message on resume; nothing reaches it now', toPaused.body?.status === 'unrouted' && toPaused.body?.held === true
      && providerCalls.some((call) => call.body?.text === "Ben's Assistant was paused by an admin. It will pick up what you sent when they resume it."), [toPaused.body, providerCalls]);
    check('admin pause: nobody is alerted about a deliberate pause', await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1", [s.benAgent]) === toldBeforePause);
    providerCalls.length = 0;
    const toPausedAgain = await inbound(telegramId, update(104, 'anyone?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('admin pause: a second message in the same chat gets no second line', toPausedAgain.body?.status === 'unrouted'
      && !providerCalls.some((call) => call.url.endsWith('/sendMessage')), providerCalls);
    // In a group: the personal bot answers DMs only, so neither chatter nor a mention gets anything.
    const inGroup = (id: number, text: string) => ({ update_id: id, message: { message_id: id, from: { id: 5550001, username: 'benode' }, chat: { id: -200, type: 'group' }, text } });
    providerCalls.length = 0;
    const groupChatter = await inbound(telegramId, inGroup(105, 'lunch at noon?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('group: the personal bot ignores chatter', groupChatter.body?.status === 'ignored' && groupChatter.body?.reason === 'personal_dm_only' && providerCalls.length === 0, providerCalls);
    const groupMention = await inbound(telegramId, inGroup(106, '@acme_assistant_bot what is next?'), { 'x-telegram-bot-api-secret-token': telegramSecret });
    check('group: and a mention of it, recording nothing', groupMention.body?.status === 'ignored' && providerCalls.length === 0
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE dedupe_key IN ('update:105', 'update:106')") === 0, providerCalls);

    // ── Status list ────────────────────────────────────────────────────
    const memberStatus = await session(statusRoute.GET, 'GET', '/api/workspace/assistants/status');
    check('status: a member cannot list everyone\'s', memberStatus.status === 403, memberStatus.body);
    as(LOGINS.owner);
    const status = await session(statusRoute.GET, 'GET', '/api/workspace/assistants/status');
    const rows = status.body?.data?.assistants ?? [];
    check('status: the Owner sees each with its state; an admin pause is on hold, not needs you', status.status === 200
      && rows.some((r: Loose) => r.id === s.benAgent && r.state === 'on_hold' && r.reason === 'paused_by_admin')
      && rows.some((r: Loose) => r.id === s.anaAgent && r.state === 'working') && !rows.some((r: Loose) => r.state === 'broken'), rows);

    // Held while paused: the newest 20 reach it on resume, oldest first; older ones are kept, marked handled.
    for (let i = 0; i < 21; i++) {
      await s.q(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_user_id, member_id, agent_id, text, dedupe_key, created_at)
        VALUES ($1, 'inbound', 'unrouted', '5550001', '5550001', $2, $3, $4, $5, now() - interval '1 day' + make_interval(mins => $6))`, [telegramId, s.ben, s.benAgent, `old ${i}`, `held:${i}`, i]);
    }
    const { deliverHeldChat } = await import('../src/lib/chat/inbound');
    const whileSuspended = await deliverHeldChat(service, s.benAgent);
    await s.q("UPDATE pm.team_members SET status = 'active', suspended_by = NULL, suspended_at = NULL WHERE id = $1", [s.benAgent]);
    const sentOnResume = await deliverHeldChat(service, s.benAgent);
    const heldRows = await s.q<Loose>("SELECT dedupe_key, status, handled_at FROM pm.chat_messages WHERE agent_id = $1 AND direction = 'inbound' AND (dedupe_key LIKE 'held:%' OR dedupe_key IN ('update:103', 'update:104')) ORDER BY created_at", [s.benAgent]);
    const deliveredHeld = heldRows.filter((row) => row.status !== 'unrouted');
    check('paused messages: nothing is delivered while still paused', whileSuspended === 0, whileSuspended);
    check('paused messages: on resume the newest 20 reach it (pending or notified), the 3 oldest are kept and marked handled', sentOnResume === 20 && deliveredHeld.length === 20
      && heldRows.slice(0, 3).every((row) => row.status === 'unrouted' && row.handled_at !== null) && deliveredHeld.every((row) => ['pending', 'notified'].includes(row.status)),
      { sentOnResume, heldRows: heldRows.map((row) => `${row.dedupe_key}:${row.status}`) });
    check('paused messages: delivered once, a second call sends nothing', await deliverHeldChat(service, s.benAgent) === 0);
    // Back to how the rest of this script expects Ben's assistant: paused by an admin.
    await s.q("UPDATE pm.team_members SET status = 'suspended', suspended_by = $1, suspended_at = now() WHERE id = $2", [s.owner, s.benAgent]);

    // ── Can't answer right now: one line per chat per spell ────────────
    const slackLines = () => providerCalls.filter((call) => call.url.endsWith('/chat.postMessage')).map((call) => call.body?.text as string);
    const fromAnaNow = async (id: string, text: string) => {
      const body = event(id, 'U_ANA', text);
      return inbound(slackId, body, slackSigned(body));
    };
    const ON_HOLD_LINE = "Nova is on hold for now. It will reply when it's back.";
    await s.q('UPDATE pm.business_settings SET agents_paused_at = now(), agents_paused_by = $1', [s.owner]);
    providerCalls.length = 0;
    const held1 = await fromAnaNow('EvHold1', 'Book the venue for Friday');
    check('on hold: the message is still recorded and sent to the assistant', held1.body?.status === 'notified'
      && (await s.q<Loose>('SELECT agent_id FROM pm.chat_messages WHERE id = $1', [held1.body?.id]))[0]?.agent_id === s.anaAgent, held1.body);
    check('on hold: the person hears why, once, in the chat, with its name', JSON.stringify(slackLines()) === JSON.stringify([ON_HOLD_LINE])
      && providerCalls[0]?.body?.channel === 'D_ANA', providerCalls);
    providerCalls.length = 0;
    const held2 = await fromAnaNow('EvHold2', 'And order lunch');
    check('on hold: a second message gets no second line', held2.body?.status === 'notified' && slackLines().length === 0, providerCalls);
    const heldReply = await v1(v1Reply.POST, 'POST', `/api/v1/assistant/messages/${held1.body?.id}/reply`, { id: held1.body?.id }, s.keys.anaAgent.secret, { text: 'On it.' });
    check('on hold: the assistant cannot answer yet (423)', heldReply.status === 423, heldReply.body);
    await s.q('UPDATE pm.business_settings SET agents_paused_at = NULL, agents_paused_by = NULL');
    const waiting = await v1(v1Messages.GET, 'GET', '/api/v1/assistant/messages?status=notified', {}, s.keys.anaAgent.secret);
    const resumedReply = await v1(v1Reply.POST, 'POST', `/api/v1/assistant/messages/${held1.body?.id}/reply`, { id: held1.body?.id }, s.keys.anaAgent.secret, { text: 'Booked for Friday.' });
    check('on hold: resumed, the held messages reach the assistant and it answers', [held1.body?.id, held2.body?.id].every((id) => (waiting.body?.data?.messages ?? []).some((m: Loose) => m.id === id))
      && resumedReply.status === 201, { waiting: waiting.body?.data?.messages?.length, reply: resumedReply.body });
    providerCalls.length = 0;
    const working = await fromAnaNow('EvWork1', 'Thanks');
    check('working: no line', working.body?.status === 'notified' && slackLines().length === 0, providerCalls);
    await s.q("UPDATE pm.business_settings SET agents_paused_at = now() + interval '1 second', agents_paused_by = $1", [s.owner]);
    providerCalls.length = 0;
    await fromAnaNow('EvHold3', 'One more thing');
    check('on hold: a new hold after a resume gets the line again', JSON.stringify(slackLines()) === JSON.stringify([ON_HOLD_LINE]), providerCalls);
    check('on hold: each line is recorded as the app\'s own outbound message',
      await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1 AND direction = 'outbound' AND dedupe_key LIKE 'notice:%' AND text = $2", [slackId, ON_HOLD_LINE]) === 2);
    providerCalls.length = 0;
    const newStranger = event('EvStrangerHold', 'U_NEWCOMER', 'hi', 'D_NEWCOMER');
    await inbound(slackId, newStranger, slackSigned(newStranger));
    check('strangers: still today\'s link prompt, never the on-hold line', slackLines().length === 1 && /\/link\/pl_/.test(slackLines()[0]) && !/on hold/.test(slackLines()[0]), providerCalls);

    // A dead host while on hold: Status and her page say so; the admins hear once a day.
    await s.q("INSERT INTO pm.agent_health (member_id, container_running, turn_running, reported_at, expected_interval_seconds) VALUES ($1, true, false, now() - interval '10 minutes', 60)", [s.anaAgent]);
    as(LOGINS.ana);
    const deadView = (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant;
    check('dead host: on hold, her page says its host is not responding', deadView?.state === 'on_hold' && deadView.host_down === true, deadView);
    as(LOGINS.owner);
    const deadRows = (await session(statusRoute.GET, 'GET', '/api/workspace/assistants/status')).body?.data?.assistants ?? [];
    const deadRow = deadRows.find((r: Loose) => r.id === s.anaAgent);
    check('dead host: Status shows it on hold with its host down, first (nothing is broken)', deadRow?.state === 'on_hold' && deadRow.host_down === true && deadRows[0]?.id === s.anaAgent, deadRows);
    const hostTold = await s.q<Loose>("SELECT title FROM pm.team_member_notifications WHERE user_id = $1 AND entity_type = 'member' AND entity_id = $2", [s.owner, s.anaAgent]);
    check('dead host: the admin is told, once', hostTold.length === 1 && /host is not responding/.test(hostTold[0].title), hostTold);
    as(LOGINS.ana);
    await session(assistantRoute.GET, 'GET', '/api/workspace/assistant');
    check('dead host: not again on the next visit', await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1", [s.anaAgent]) === 1);
    await s.q("UPDATE pm.agent_health SET reported_at = now() WHERE member_id = $1", [s.anaAgent]);
    const aliveView = (await session(assistantRoute.GET, 'GET', '/api/workspace/assistant')).body?.data?.assistant;
    check('dead host: a beating host on hold is plain on hold', aliveView?.state === 'on_hold' && aliveView.host_down === false, aliveView);
    await s.q('UPDATE pm.business_settings SET agents_paused_at = NULL, agents_paused_by = NULL');

    // Paused by her: recorded, never sent; the line links to her page.
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: true });
    providerCalls.length = 0;
    const toHerPaused = await fromAnaNow('EvPaused1', 'Are you there?');
    check('paused by her: the line with its name and a link to her page, held, nothing reaches it yet', toHerPaused.body?.status === 'unrouted' && toHerPaused.body?.held === true
      && JSON.stringify(slackLines()) === JSON.stringify(['Nova is paused. Resume it on your Helper page and it will pick up what you sent.\nhttps://pm.example.com/assistant']), [toHerPaused.body, providerCalls]);
    providerCalls.length = 0;
    await fromAnaNow('EvPaused2', 'Hello?');
    check('paused by her: once, not on every message', slackLines().length === 0, providerCalls);
    await session(assistantRoute.PATCH, 'PATCH', '/api/workspace/assistant', {}, { paused: false });
    const herHeld = await s.q<Loose>("SELECT dedupe_key, status FROM pm.chat_messages WHERE dedupe_key IN ('EvPaused1', 'EvPaused2') ORDER BY created_at");
    check('paused by her: resuming delivers what she sent meanwhile, both messages', herHeld.length === 2 && herHeld.every((row) => ['pending', 'notified'].includes(row.status)), herHeld);

    // ── Replace a token or signing secret, in place ───────────────────
    as(LOGINS.owner);
    const historyBefore = await count('SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1', [slackId]);
    const NEW_SECRET = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
    const replaced = await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${slackId}`, { id: slackId }, { bot_token: 'xoxb-3333-4444-replacedtokenvalue', signing_secret: NEW_SECRET });
    const replacedRow = (await s.q<Loose>('SELECT id, credentials FROM pm.chat_connections WHERE id = $1', [slackId]))[0];
    check('replace: a new token and signing secret keep the connection, its Request URL and its history', replaced.status === 200 && replaced.body?.data?.id === slackId
      && replaced.body.data.inbound_url === `https://pm.example.com/api/chat/inbound/${slackId}` && !replaced.text.includes('replacedtokenvalue')
      && await count('SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1', [slackId]) === historyBefore && replacedRow?.credentials?.startsWith('pm1:'), replaced.body);
    const oldSigned = await inbound(slackId, challenge, slackSigned(challenge));
    const newSigned = await inbound(slackId, challenge, slackSigned(challenge, {}, NEW_SECRET));
    check('replace: the old signing secret stops working, the new one works', oldSigned.status === 401 && newSigned.status === 200 && newSigned.body?.challenge === 'chal-123', [oldSigned.status, newSigned.body]);
    slackTeam = 'T9';
    const otherWorkspace = await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${slackId}`, { id: slackId }, { bot_token: 'xoxb-5555-6666-otherworkspacetoken' });
    slackTeam = 'T1';
    check('replace: a token for another Slack workspace is refused, nothing changes', otherWorkspace.status === 422 && reason(otherWorkspace) === 'different_bot'
      && (await s.q<Loose>('SELECT credentials FROM pm.chat_connections WHERE id = $1', [slackId]))[0]?.credentials === replacedRow?.credentials, otherWorkspace.body);
    // Another bot's Telegram token: refused before its webhook is touched, so that bot keeps working.
    const telegramBefore = (await s.q<Loose>('SELECT credentials FROM pm.chat_connections WHERE id = $1', [telegramId]))[0]?.credentials;
    providerCalls.length = 0;
    telegramBotId = 4242;
    const otherBot = await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${telegramId}`, { id: telegramId }, { bot_token: '424242424:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ' });
    telegramBotId = 999;
    check('replace: a Telegram token for another bot is refused and its webhook is never set', otherBot.status === 422 && reason(otherBot) === 'different_bot'
      && !providerCalls.some((call) => call.url.endsWith('/setWebhook'))
      && (await s.q<Loose>('SELECT credentials FROM pm.chat_connections WHERE id = $1', [telegramId]))[0]?.credentials === telegramBefore, { body: otherBot.body, providerCalls });
    const badShape = await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${slackId}`, { id: slackId }, { signing_secret: 'not a secret' });
    check('replace: a signing secret in the wrong shape is refused', badShape.status === 422 && reason(badShape) === 'invalid_signing_secret', badShape.body);

    // Linked from chat: the bot says so where they wrote, so they know to write again.
    providerCalls.length = 0;
    const newbie = event('EvNewbie1', 'U_NEWBIE', 'hi', 'D_NEWBIE');
    await inbound(slackId, newbie, slackSigned(newbie, {}, NEW_SECRET));
    const newbieToken = /\/link\/(pl_[a-f0-9]{64})/.exec(slackLines()[0] ?? '')?.[1] ?? '';
    // Security review finding 5: the link alone (forwarded to someone else) never links; the code from the DM does.
    const newbieCode = /type this code: ([A-Z0-9]{4})/.exec(slackLines()[0] ?? '')?.[1] ?? '';
    check('link code: the DM carries a 4-character code with the link', /^[A-HJ-NP-Z2-9]{4}$/.test(newbieCode), slackLines()[0]);
    const linkPage = await session(linkRoute.GET, 'GET', `/api/workspace/identities/link/${newbieToken}`, { token: newbieToken });
    check('link code: the confirm page knows to ask for it', linkPage.status === 200 && linkPage.body?.data?.needs_code === true && linkPage.body?.data?.from_chat === true, linkPage.body);
    const forwarded = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${newbieToken}`, { token: newbieToken });
    check('link code: clicking a forwarded link without the code links nothing (422 code_required)', forwarded.status === 422 && reason(forwarded) === 'code_required', forwarded.body);
    const wrongCode = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${newbieToken}`, { token: newbieToken }, { code: newbieCode === 'AAAA' ? 'BBBB' : 'AAAA' });
    check('link code: a wrong code links nothing (422 code_wrong)', wrongCode.status === 422 && reason(wrongCode) === 'code_wrong', wrongCode.body);
    providerCalls.length = 0;
    const confirmed = await session(linkRoute.POST, 'POST', `/api/workspace/identities/link/${newbieToken}`, { token: newbieToken }, { code: newbieCode.toLowerCase() });
    await settle();
    check('linked: confirming the link makes the bot say so in the chat they wrote from', confirmed.status === 200 && !!newbieToken
      && providerCalls.some((call) => call.body?.channel === 'D_NEWBIE' && /^Linked\./.test(call.body?.text ?? '')), { confirmed: confirmed.body, providerCalls });
    as(LOGINS.ana);
    await s.q('DELETE FROM pm.agent_health WHERE member_id = $1', [s.anaAgent]);
    as(LOGINS.owner);

    // ── Removing a connection ──────────────────────────────────────────
    providerCalls.length = 0;
    const removed = await session(connectionRoute.DELETE, 'DELETE', `/api/workspace/chat-connections/${telegramId}`, { id: telegramId });
    check('connections: removing Telegram deletes its webhook and its chat history', removed.status === 200 && providerCalls.some((call) => call.url.endsWith('/deleteWebhook'))
      && await count('SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1', [telegramId]) === 0, removed.body);
    // ── One endpoint for every assistant of a setup ────────────────────
    const setupA = setup.body?.data?.id as string;
    const guestSetup = await session(setupsRoute.POST, 'POST', '/api/workspace/assistants/setups', {}, { match_role: 'guest' });
    const setupB = guestSetup.body?.data?.id as string;
    // Ana's and Ben's assistants came from the members' setup; Olivia's from the guests' (made by hand here).
    await s.q('UPDATE pm.team_members SET assistant_setup_id = $1 WHERE id = ANY($2::uuid[])', [setupA, [s.anaAgent, s.benAgent]]);
    const oliviaAgent = (await s.q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template, assistant_setup_id)
      VALUES ('Olivia''s Assistant', 'olivia.assistant@example.com', 'agent', $1, 'personal-assistant', $2) RETURNING id`, [s.owner, setupB]))[0].id;
    // Provisioning records the setup that made an agent, also when the caller does not say (pm.assistant_setup_for).
    const dee = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Dee New', 'dee@example.com', 'member') RETURNING id"))[0].id;
    const provisioned = await s.q<Loose>(`SELECT * FROM pm.provision_personal_agents(jsonb_build_array(jsonb_build_object('name', 'Dee''s Assistant', 'email', 'dee.assistant@example.com',
      'delegate_of', $1::uuid, 'assistant_template', 'personal-assistant')), $2)`, [dee, s.owner]);
    check('setup scope: a provisioned agent records the setup that made it', provisioned.length === 1
      && (await s.q<Loose>('SELECT assistant_setup_id FROM pm.team_members WHERE id = $1', [provisioned[0]?.id]))[0]?.assistant_setup_id === setupA, provisioned);

    const hostBody = { name: 'Assistant host', url: 'https://hooks.example.test/host', events: ['assistant.message', 'task.updated'], assistant_setup_id: setupA };
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'webhooks.manage', 'api', 'allow') ON CONFLICT DO NOTHING", [s.ben]);
    const benHooksKey = await s.key(s.ben, ['webhooks.manage']);
    const notOwner = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, benHooksKey.secret, hostBody);
    check('setup scope: a key without Owner or assistants.provision cannot scope to a setup, 403', notOwner.status === 403 && reason(notOwner) === 'setup_scope_not_allowed', notOwner.body);
    const both = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, { ...hostBody, member_id: s.anaAgent });
    check('setup scope: member_id and assistant_setup_id together are refused', both.status >= 400 && both.status < 500
      && await count("SELECT count(*)::int AS n FROM pm.webhook_endpoints WHERE name = 'Assistant host'") === 0, both.body);
    const badTarget = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, { ...hostBody, url: 'https://169.254.169.254/latest' });
    check('target guard: the API refuses a metadata address', badTarget.status >= 400 && badTarget.status < 500 && /public address/.test(badTarget.text), badTarget.body);
    const hostMade = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, hostBody);
    const hostId = hostMade.body?.data?.endpoint?.id as string;
    check('setup scope: an Owner\'s key makes one endpoint for the whole setup, assistant.message included', hostMade.status === 201
      && hostMade.body.data.endpoint.assistant_setup_id === setupA && hostMade.body.data.endpoint.member_id === null, hostMade.body);
    const listed = await v1(v1Webhooks.GET, 'GET', `/api/v1/webhook-endpoints?assistant_setup_id=${setupA}`, {}, s.keys.owner.secret);
    check('setup scope: the list narrows to a setup\'s endpoints', listed.status === 200 && listed.body.data.length === 1 && listed.body.data[0].id === hostId, listed.body);
    // The database keeps the rules on its own too.
    const sqlBoth = await db.query('INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id, assistant_setup_id) VALUES ($1, $2, $3, $4, $5, $6)',
      ['Both', 'https://hooks.example.test/both', 'whsec_b', '{task.updated}', s.anaAgent, setupA]).then(() => null, (e: Error) => e.message);
    check('setup scope: the database refuses member_id with assistant_setup_id', /webhook_endpoints_one_scope/.test(sqlBoth ?? ''), sqlBoth);
    // Ana may manage webhooks in Settings for this check, so only the setup guard stands in her way.
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'webhooks.manage', 'app', 'allow') ON CONFLICT DO NOTHING", [s.ana]);
    await actAs(db, LOGINS.ana.id);
    const seesIt = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.webhook_endpoints WHERE name = 'Nova harness'")).rows[0].n;
    const memberScopes = await db.query("UPDATE pm.webhook_endpoints SET member_id = NULL, assistant_setup_id = $1 WHERE name = 'Nova harness'", [setupB]).then(() => null, (e: Error) => e.message);
    await actAs(db, null);
    await s.q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'webhooks.manage' AND access_channel = 'app'", [s.ana]);
    check('setup scope: a signed-in non-Owner who manages webhooks still cannot scope an endpoint to a setup', seesIt === 1 && /Only an Owner scopes/.test(memberScopes ?? ''), { seesIt, memberScopes });

    // Fan-out: two assistants of the setup reach the one endpoint; another setup's assistant and a shared agent do not.
    const messageFor = async (agentId: string) => {
      const id = randomUUID();
      const emitted = (await s.q<{ ok: boolean }>('SELECT pm.emit_assistant_message($1, $2, $3) AS ok', [id, agentId, { agent_id: agentId }]))[0].ok;
      return { id, emitted };
    };
    const [toAna, toBen, toOlivia, toJeff] = [await messageFor(s.anaAgent), await messageFor(s.benAgent), await messageFor(oliviaAgent), await messageFor(s.jeff)];
    const hostGot = async (messageId: string) => count(`SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id
      WHERE d.endpoint_id = $1 AND ev.resource_id = $2`, [hostId, messageId]);
    check('setup scope: assistant.message for two assistants of the setup goes to its one endpoint', toAna.emitted && toBen.emitted
      && await hostGot(toAna.id) === 1 && await hostGot(toBen.id) === 1, { toAna, toBen });
    check('setup scope: never for another setup\'s assistant or a shared agent', !toOlivia.emitted && !toJeff.emitted
      && await hostGot(toOlivia.id) === 0 && await hostGot(toJeff.id) === 0, { toOlivia, toJeff });
    check('per-member endpoints still work: Ana\'s own endpoint hears her message too', await count(`SELECT count(*)::int AS n FROM pm.webhook_deliveries d
      JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id JOIN pm.webhook_endpoints e ON e.id = d.endpoint_id
      WHERE e.name = 'Nova harness' AND ev.resource_id = $1`, [toAna.id]) === 1);
    deliveries.length = 0;
    await runDispatch();
    const hostDeliveries = deliveries.filter((delivery) => delivery.url === 'https://hooks.example.test/host');
    check('setup scope: the host gets each, signed, with the agent id to route on', hostDeliveries.length === 2
      && hostDeliveries.every((delivery) => !!delivery.headers.get('x-vm-signature'))
      && JSON.stringify(hostDeliveries.map((delivery) => delivery.body?.data?.agent_id).sort()) === JSON.stringify([s.anaAgent, s.benAgent].sort()), hostDeliveries.map((d) => d.body));

    // Work events concerning an assistant of the setup reach it too; one concerning nobody of it does not.
    const taskFor = async (memberIds: string[]) => {
      const id = randomUUID();
      await s.q("SELECT pm.emit_webhook_event('task.updated', 'task', $1, ARRAY[$2]::uuid[], $3::uuid[], '{}'::jsonb)", [id, s.project, memberIds]);
      return count(`SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id
        WHERE d.endpoint_id = $1 AND ev.resource_id = $2`, [hostId, id]);
    };
    check('setup scope: a task event that concerns one of its assistants reaches the host', await taskFor([s.ana, s.benAgent]) === 1);
    check('setup scope: one that concerns only people and other agents does not', await taskFor([s.ana, s.jeff, oliviaAgent]) === 0);

    // One pass: the matcher runs once per active endpoint subscribed to the type, never twice.
    await s.q("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Tasks A', 'https://hooks.example.test/a', 'whsec_a', '{task.updated}'), ('Tasks B', 'https://hooks.example.test/b', 'whsec_b', '{task.updated}'), ('Other', 'https://hooks.example.test/o', 'whsec_o', '{task.created}')");
    const subscribed = await count("SELECT count(*)::int AS n FROM pm.webhook_endpoints WHERE is_active AND 'task.updated' = ANY (events)");
    await db.exec('RESET ROLE');
    await db.exec('BEGIN');
    let matcherCalls = -1;
    try {
      await db.exec("SET LOCAL track_functions = 'all'");
      await db.query("SELECT pm.emit_webhook_event('task.updated', 'task', $1, ARRAY[$2]::uuid[], ARRAY[$3]::uuid[], '{}'::jsonb)", [randomUUID(), s.project, s.anaAgent]);
      matcherCalls = (await db.query<{ n: number }>("SELECT coalesce(pg_stat_get_xact_function_calls('pm.webhook_endpoint_matches(pm.webhook_endpoints, text, uuid[], uuid[])'::regprocedure), 0)::int AS n")).rows[0].n;
    } finally {
      await db.exec('ROLLBACK');
    }
    check('fan-out: one pass over the endpoints per event (the matcher runs once per subscribed endpoint)', subscribed >= 3 && matcherCalls === subscribed, { matcherCalls, subscribed });

    // A setup its endpoints serve is not deleted out from under them.
    const keepSetup = await session(setupRoute.DELETE, 'DELETE', `/api/workspace/assistants/setups/${setupA}`, { id: setupA });
    check('setup scope: deleting a setup an endpoint serves is refused, 409', keepSetup.status === 409 && reason(keepSetup) === 'setup_has_webhooks'
      && await count('SELECT count(*)::int AS n FROM pm.assistant_setups WHERE id = $1', [setupA]) === 1, keepSetup.body);

    check('logs: no token was ever written to the audit log', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE request_body::text LIKE '%xoxb%' OR request_body::text LIKE '%AAHdq%'") === 0);
    await jeffWorks('at the end');
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(webhookTransport, realTransport);
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
