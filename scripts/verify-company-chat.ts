/**
 * The two bots (20261125001100_chat_targets.sql), end to end over the real
 * routes (session routes with a signed-in Owner, v1 routes with keys, the
 * public inbound route, a fake PostgREST over PGlite with the full schema,
 * every chat provider call mocked):
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   connections made before read as personal; the new tables and function
 *   are the server's only.
 * - The personal bot: DMs to each person's own assistant, channels ignored;
 *   assistant.message exactly as before, chat.message beside it (to the
 *   setup-scoped endpoint too).
 * - The company bot: which agents it reaches (shared ones that may act for
 *   people), channel mappings by name or id, routing by mention, channel
 *   and default, listen all as context, strangers, Slack's twin events.
 * - The sender is the principal: replies need X-Act-For for them, and acting
 *   for them reaches only what both reach.
 * - Replies thread, broadcast, go private by DM, and carry the agent's name
 *   and avatar on Slack; Telegram replies to the message.
 * - The once-per-hold line for a company agent; MCP visibility.
 *
 *   npm run -s test:company-chat
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
import { slackSignature } from '../src/lib/chat/providers/slack';
import { chatHttp } from '../src/lib/chat/providers/adapter';
import { agentNamed, routeCompany, type CompanyAgent } from '../src/lib/chat/inbound';
import { webhookTransport } from '../src/lib/webhooks/target';
import { CHAT_APPS, chatAppConnectable, freeChatKinds } from '../src/lib/chat/types';

const MIGRATION = '20261125001100_chat_targets.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- CHAT TARGETS (20261125001100_chat_targets.sql)';
const APP_KEY = 'd'.repeat(64);
const PERSONAL_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const COMPANY_SECRET = '0f9e8d7c6b5a49382716051f2e3d4c5b';
const PERSONAL_TOKEN = 'xoxb-1111-2222-personalpersonal';
const COMPANY_TOKEN = 'xoxb-3333-4444-companycompany';
const TELEGRAM_TOKEN = '777000111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDcomp';
const FINANCE_AVATAR = 'https://cdn.example.com/finance.png';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const OWNER = { id: '00000000-0000-4000-8000-00000000e001', email: 'olivia@example.com' };

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: OWNER.id, aud: 'authenticated', role: 'authenticated', email: OWNER.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-25T00:00:00Z' }));
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
      const user = { id: OWNER.id, email: OWNER.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-25T00:00:00Z' };
      const session = {
        access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: OWNER.id, email: OWNER.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
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
  const agent = (id: string, name: string, isDefault = false): CompanyAgent => ({ id, name, is_default: isDefault, row: { id, name } });
  const ops = agent('ops', 'Ops AI', true);
  const opsLead = agent('lead', 'Ops AI Lead');
  const finance = agent('fin', 'Finance Bot');
  const agents = [ops, opsLead, finance];
  check('named: "@" and the name, any case', agentNamed('hey @finance bot, the cash?', agents)?.id === 'fin');
  check('named: the longest name wins', agentNamed('@Ops AI Lead please look', agents)?.id === 'lead' && agentNamed('@Ops AI please look', agents)?.id === 'ops');
  check('named: not inside a word or an email', agentNamed('mail me at x@finance botsmith.com', agents) === null && agentNamed('ab@Ops AI', agents) === null);
  const base = { botMentioned: false, text: 'hello', agents, channel: null };
  check('route: a DM goes to the default', JSON.stringify(routeCompany({ ...base, direct: true })) === JSON.stringify({ kind: 'request', agent: ops, route: 'direct' }));
  check('route: a DM naming an agent goes to it', routeCompany({ ...base, direct: true, text: '@Finance Bot hi' }).kind === 'request'
    && (routeCompany({ ...base, direct: true, text: '@Finance Bot hi' }) as Loose).agent.id === 'fin');
  check('route: a bot mention in an unmapped channel goes to the default', (routeCompany({ ...base, direct: false, botMentioned: true }) as Loose).route === 'default');
  check('route: chatter in an unmapped channel is ignored', routeCompany({ ...base, direct: false }).kind === 'ignore');
  const mappedAll = { agent_id: 'fin', listen: 'all' };
  const mappedMentions = { agent_id: 'fin', listen: 'mentions' };
  check('route: listen all records chatter as context for the mapped agent', JSON.stringify(routeCompany({ ...base, direct: false, channel: mappedAll })) === JSON.stringify({ kind: 'context', agent: finance, route: 'channel' }));
  check('route: listen mentions ignores chatter', routeCompany({ ...base, direct: false, channel: mappedMentions }).kind === 'ignore');
  check('route: a bot mention in a mapped channel goes to the mapped agent', JSON.stringify(routeCompany({ ...base, direct: false, botMentioned: true, channel: mappedMentions }))
    === JSON.stringify({ kind: 'request', agent: finance, route: 'channel' }));
  check('route: naming another agent in a mapped channel goes to the named one', (routeCompany({ ...base, direct: false, text: '@Ops AI deploy?', channel: mappedAll }) as Loose).agent.id === 'ops');
  check('route: no default, a DM is a request nobody takes', (routeCompany({ ...base, agents: [finance], direct: true }) as Loose).agent === null);
  const slots = (list: { provider: string; kind: 'personal' | 'company' }[]) => JSON.stringify(freeChatKinds(list));
  const both = ['personal', 'company'];
  check('slots: nothing connected leaves both kinds on every app', slots([]) === JSON.stringify({ slack: both, telegram: both, discord: both }));
  check('slots: a connected kind is taken on its own app only', slots([{ provider: 'slack', kind: 'personal' }]) === JSON.stringify({ slack: ['company'], telegram: both, discord: both }));
  check('slots: every kind on every app leaves nothing', slots([
    { provider: 'slack', kind: 'personal' }, { provider: 'slack', kind: 'company' },
    { provider: 'telegram', kind: 'personal' }, { provider: 'telegram', kind: 'company' },
    { provider: 'discord', kind: 'personal' }, { provider: 'discord', kind: 'company' },
  ]) === JSON.stringify({ slack: [], telegram: [], discord: [] }));
  check('chat apps: Slack, Telegram and Discord connect; each listed app is available',
    chatAppConnectable('slack') && chatAppConnectable('telegram') && chatAppConnectable('discord') && !chatAppConnectable('teams') && CHAT_APPS.every((app) => app.available));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Connections: kind')).trim();
  check('schema.sql: the chat targets section mirrors the migration', at > 0 && banner > 0 && SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  await old.exec('RESET ROLE');
  const legacySlack = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials) VALUES ('slack', 'T9', 'Old Slack', 'pm1:x') RETURNING id"))[0].id;
  const legacyTelegram = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials) VALUES ('telegram', '4242', 'Old bot', 'pm1:y') RETURNING id"))[0].id;
  const legacyMessage = (await q<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text)
    VALUES ($1, 'inbound', 'pending', 'D1', 'hi') RETURNING id`, [legacySlack]))[0].id;
  // One provider message recorded twice before (concurrent twins).
  const twinRows = (await q<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_message_id, text, created_at)
    VALUES ($1, 'inbound', 'replied', 'C7', '1700.1', 'first words', now() - interval '2 minutes'), ($1, 'inbound', 'pending', 'C7', '1700.1', 'first words', now() - interval '1 minute') RETURNING id`, [legacySlack])).map((r) => r.id);
  await applyMigrationsFrom(old, MIGRATION);
  const twinsAfter = await q<Loose>('SELECT id, external_message_id, text FROM pm.chat_messages WHERE id = ANY($1::uuid[])', [twinRows]);
  check('upgrade: twins recorded before keep their rows and text; only the oldest keeps the provider message id', twinsAfter.length === 2 && twinsAfter.every((r) => r.text === 'first words')
    && twinsAfter.find((r) => r.id === twinRows[0])?.external_message_id === '1700.1' && twinsAfter.find((r) => r.id === twinRows[1])?.external_message_id === null, twinsAfter);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();
  const kinds = await q<Loose>('SELECT id, kind, external_bot_id FROM pm.chat_connections ORDER BY created_at');
  check('upgrade: connections made before are personal; Telegram takes its bot id from its workspace id',
    kinds.every((row) => row.kind === 'personal') && kinds.find((row) => row.id === legacyTelegram)?.external_bot_id === '4242'
    && kinds.find((row) => row.id === legacySlack)?.external_bot_id === null, kinds);
  const message = (await q<Loose>('SELECT is_request, is_direct, route FROM pm.chat_messages WHERE id = $1', [legacyMessage]))[0];
  check('upgrade: messages made before are requests', message?.is_request === true && message.is_direct === null && message.route === null, message);
  const context = await old.query("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, is_request) VALUES ($1, 'inbound', 'pending', 'C1', 'x', false)", [legacySlack])
    .then(() => null, (e: Error) => e.message);
  check('database: context is always status context', /chat_messages_context_check/.test(context ?? ''), context);
  const sameKind = await old.query("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials) VALUES ('slack', 'T9', 'Twin', 'pm1:z')").then(() => null, (e: Error) => e.message);
  const otherKind = await old.query("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials, kind) VALUES ('slack', 'T9', 'Company', 'pm1:z', 'company')").then(() => null, (e: Error) => e.message);
  check('database: one connection per workspace and kind (a personal and a company app share a workspace)', /duplicate|unique/i.test(sameKind ?? '') && otherKind === null, { sameKind, otherKind });
  const grants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = 'emit_chat_message'`);
  check('grants: emit_chat_message is the server\'s only', grants.length === 1 && !grants[0].anon && !grants[0].auth && grants[0].svc, grants);
  const tables = await q<Loose>(`SELECT t AS name, has_table_privilege('authenticated', 'pm.' || t, 'SELECT') AS auth, has_table_privilege('anon', 'pm.' || t, 'SELECT') AS anon
    FROM unnest(ARRAY['chat_connection_agents', 'chat_channel_routes']) AS t`);
  check('grants: the new tables are the server\'s only', tables.length === 2 && tables.every((t: Loose) => !t.auth && !t.anon), tables);
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const CHAT_SCOPES = ['notifications.manage_own', 'projects.read', 'tasks.read', 'agents.act_for'];
const TEMPLATE_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'reminders.manage_own', 'notifications.manage_own', 'agent_activity.write'];

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
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  const member = async (name: string, role: string, extra: { delegateOf?: string; avatar?: string } = {}) => {
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    return (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template, avatar) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, email, role, extra.delegateOf ?? null, extra.delegateOf ? 'personal-assistant' : null, extra.avatar ?? '']))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [OWNER.id, OWNER.email]);
  await q('UPDATE pm.team_members SET auth_user_id = $1, email = $2 WHERE id = $3', [OWNER.id, OWNER.email, owner]);
  const ana = await member('Ana Lopez', 'member');
  const ben = await member('Ben Ode', 'member');
  const anaAgent = await member("Ana's Assistant", 'agent', { delegateOf: ana });
  const ops = await member('Ops AI', 'agent');
  const finance = await member('Finance Bot', 'agent', { avatar: FINANCE_AVATAR });
  const jeff = await member('Jeff', 'agent');
  const shared = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Shared') RETURNING id"))[0].id;
  for (const m of [ana, ben, ops, finance]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [shared, m]);
  // Ben's and the Finance Bot's: Ana cannot open it, so the bot acting for her cannot either.
  const secret = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Ledger') RETURNING id"))[0].id;
  for (const m of [ben, finance]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [secret, m]);
  for (const m of [ana, ben, ops, finance]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny'), ($1, 'projects.read_all', 'app', 'deny') ON CONFLICT DO NOTHING", [m]);
  }
  for (const m of [ops, finance]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow') ON CONFLICT DO NOTHING", [m]);
  }
  const key = async (memberId: string, scopes: string[]) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes]);
    return secretKey;
  };
  const keys = {
    ops: await key(ops, CHAT_SCOPES),
    finance: await key(finance, CHAT_SCOPES),
    jeff: await key(jeff, ['notifications.manage_own', 'projects.read']),
    anaAgent: await key(anaAgent, TEMPLATE_SCOPES),
    owner: await key(owner, ['webhooks.manage', 'projects.read']),
  };
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES
    ($1, 'slack', 'U_ANA', 'T1', now(), 'admin'), ($2, 'slack', 'U_BEN', 'T1', now(), 'admin')`, [ana, ben]);
  await q("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'telegram', '5550001', now(), 'link')", [ana]);
  const setup = (await q<{ id: string }>("INSERT INTO pm.assistant_setups (match_role, template_key) VALUES ('member', 'personal-assistant') RETURNING id"))[0].id;
  await q('UPDATE pm.team_members SET assistant_setup_id = $1 WHERE id = $2', [setup, anaAgent]);
  return { q, owner, ana, ben, anaAgent, ops, finance, jeff, shared, secret, setup, keys };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  installSession(server.url);

  // Chat providers: every call is recorded and answered here; nothing leaves the machine.
  const providerCalls: { url: string; body: Loose; auth: string }[] = [];
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const raw = String(init?.body ?? '');
    let body: Loose;
    try { body = JSON.parse(raw || '{}'); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    providerCalls.push({ url, body, auth });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth.test')) {
      return json(auth.includes(PERSONAL_TOKEN)
        ? { ok: true, team_id: 'T1', team: 'Acme', user: 'assistant', user_id: 'UBOTP01' }
        : { ok: true, team_id: 'T1', team: 'Acme', user: 'acme-ai', user_id: 'UBOTC01' });
    }
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: `${Date.now()}.0001` });
    if (url.endsWith('/conversations.open')) return json({ ok: true, channel: { id: `D_PRIVATE_${body.users}` } });
    if (url.endsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'C_GEN', name: 'general' }, { id: 'CFIN0001', name: 'finance' }], response_metadata: { next_cursor: '' } });
    if (url.endsWith('/conversations.info')) return json({ ok: true, channel: { id: body.channel, name: 'ops' } });
    if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 777, username: 'acme_company_bot', first_name: 'Acme AI' } });
    if (url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook')) return json({ ok: true, result: true });
    if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 4242 } });
    return json({ ok: false, error: 'unknown_method' });
  };
  const deliveries: { url: string; headers: Headers; body: Loose }[] = [];
  const realTransport = { ...webhookTransport };
  webhookTransport.lookup = async (host) => (host === 'hooks.example.test' ? [{ address: '93.184.215.14', family: 4 }] : realTransport.lookup(host));
  webhookTransport.post = async (target, init) => {
    deliveries.push({ url: target.url.toString(), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return { status: 200, text: 'ok' };
  };

  try {
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const agentsRoute = await import('../src/app/api/workspace/chat-connections/[id]/agents/route');
    const channelsRoute = await import('../src/app/api/workspace/chat-connections/[id]/channels/route');
    const channelRoute = await import('../src/app/api/workspace/chat-connections/[id]/channels/[channelId]/route');
    const inboundRoute = await import('../src/app/api/chat/inbound/[id]/route');
    const v1Messages = await import('../src/app/api/v1/chat/messages/route');
    const v1Message = await import('../src/app/api/v1/chat/messages/[id]/route');
    const v1Reply = await import('../src/app/api/v1/chat/messages/[id]/reply/route');
    const v1Handled = await import('../src/app/api/v1/chat/messages/[id]/handled/route');
    const legacyMessages = await import('../src/app/api/v1/assistant/messages/route');
    const legacyMessage = await import('../src/app/api/v1/assistant/messages/[id]/route');
    const v1Webhooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const v1Delegations = await import('../src/app/api/v1/delegations/route');
    const v1Project = await import('../src/app/api/v1/projects/[id]/route');
    const { runDispatch } = await import('../src/lib/webhooks/dispatch');
    const { toolsFor } = await import('../src/lib/mcp/visibility');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
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
    const inbound = async (connectionId: string, body: unknown, headers: Record<string, string>) => read(await inboundRoute.POST(new Request(`https://pm.example.com/api/chat/inbound/${connectionId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: connectionId }) }));
    const signed = (body: unknown, secret: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, JSON.stringify(body)) };
    };
    let seq = 0;
    const slackEvent = (user: string, text: string, channel: string, channelType: 'im' | 'channel', extra: Record<string, unknown> = {}) => {
      seq++;
      return { type: 'event_callback', team_id: 'T1', event_id: `EvC${seq}`, event: { type: 'message', channel_type: channelType, user, text, channel, ts: `17000000${seq}.000100`, ...extra } };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const row = async (id: string) => (await s.q<Loose>('SELECT * FROM pm.chat_messages WHERE id = $1', [id]))[0];
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const eventFor = async (type: string, id: string) => (await s.q<Loose>('SELECT payload FROM pm.webhook_events WHERE event_type = $1 AND resource_id = $2', [type, id]))[0]?.payload;
    const posts = () => providerCalls.filter((call) => call.url.endsWith('/chat.postMessage'));

    // ── Connections ────────────────────────────────────────────────────
    const personal = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: PERSONAL_TOKEN, signing_secret: PERSONAL_SECRET });
    const personalId = personal.body?.data?.id as string;
    const company = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', kind: 'company', bot_token: COMPANY_TOKEN, signing_secret: COMPANY_SECRET });
    const companyId = company.body?.data?.id as string;
    const stored = (await s.q<Loose>('SELECT kind, external_bot_id FROM pm.chat_connections WHERE id = $1', [companyId]))[0];
    check('connections: a connection is personal unless asked; a company app joins the same Slack workspace', personal.status === 201 && personal.body.data.kind === 'personal'
      && company.status === 201 && company.body.data.kind === 'company' && stored?.external_bot_id === 'UBOTC01', { personal: personal.body, company: company.body, stored });
    const callsBeforeTwice = providerCalls.length;
    const twice = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', kind: 'company', bot_token: COMPANY_TOKEN, signing_secret: COMPANY_SECRET });
    check('connections: the same bot twice is refused, 409', twice.status === 409 && ['connection_exists', 'slot_taken'].includes(reason(twice)), twice.body);
    const otherApp = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', kind: 'company', bot_token: 'xoxb-7777-8888-anothercompanyapp', signing_secret: COMPANY_SECRET });
    check('slots: a second company Slack app is refused by the server (one per app and kind), before Slack is called', otherApp.status === 409 && reason(otherApp) === 'slot_taken'
      && providerCalls.length === callsBeforeTwice && await count("SELECT count(*)::int AS n FROM pm.chat_connections WHERE provider = 'slack' AND kind = 'company'") === 1, otherApp.body);

    // ── Which agents the company bot reaches ───────────────────────────
    const agentsPath = `/api/workspace/chat-connections/${companyId}/agents`;
    const withPersonal = await session(agentsRoute.PUT, 'PUT', agentsPath, { id: companyId }, { agent_ids: [s.anaAgent], default_agent_id: null });
    check('agents: a personal assistant is refused', withPersonal.status === 422 && reason(withPersonal) === 'personal_agent', withPersonal.body);
    const withJeff = await session(agentsRoute.PUT, 'PUT', agentsPath, { id: companyId }, { agent_ids: [s.jeff], default_agent_id: s.jeff });
    check('agents: an agent that may not act for people is refused, and told where to grant it', withJeff.status === 422 && reason(withJeff) === 'agent_cannot_act_for'
      && /Permissions/.test(withJeff.body?.error?.message ?? '') && !/Team > Access/.test(withJeff.body?.error?.message ?? ''), withJeff.body);
    const badDefault = await session(agentsRoute.PUT, 'PUT', agentsPath, { id: companyId }, { agent_ids: [s.ops], default_agent_id: s.finance });
    check('agents: the default must be one of them', badDefault.status === 422, badDefault.body);
    const set = await session(agentsRoute.PUT, 'PUT', agentsPath, { id: companyId }, { agent_ids: [s.finance, s.ops], default_agent_id: s.ops });
    check('agents: the Owner picks Ops AI (default) and Finance Bot', set.status === 200 && set.body.data.agents.length === 2 && set.body.data.agents[0].id === s.ops
      && set.body.data.agents[0].is_default === true && set.body.data.agents[1].name === 'Finance Bot', set.body);
    const onPersonal = await session(agentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${personalId}/agents`, { id: personalId }, { agent_ids: [s.ops], default_agent_id: s.ops });
    check('agents: a personal connection has none to pick', onPersonal.status === 409 && reason(onPersonal) === 'not_a_company_connection', onPersonal.body);

    // ── Channels ───────────────────────────────────────────────────────
    const channelsPath = `/api/workspace/chat-connections/${companyId}/channels`;
    providerCalls.length = 0;
    const byName = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: '#finance', agent_id: s.finance, listen: 'all' });
    const listCall = providerCalls.find((call) => call.url.endsWith('/conversations.list'));
    check('channels: a name is found with Slack and mapped, listening to everything', byName.status === 201
      && byName.body.data.channels.some((c: Loose) => c.channel_id === 'CFIN0001' && c.channel_name === '#finance' && c.listen === 'all' && c.agent_id === s.finance)
      && listCall?.body?.types === 'public_channel,private_channel' && listCall.auth === `Bearer ${COMPANY_TOKEN}`, { body: byName.body, listCall });
    const byId = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: 'COPS0001', agent_id: s.ops });
    const opsRoute = byId.body?.data?.channels?.find((c: Loose) => c.channel_id === 'COPS0001');
    check('channels: an id is taken as is, named when Slack tells, mentions only by default', byId.status === 201 && opsRoute?.channel_name === '#ops' && opsRoute.listen === 'mentions', byId.body);
    const again = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: 'COPS0001', agent_id: s.finance });
    check('channels: a channel maps once, 409', again.status === 409 && reason(again) === 'channel_exists', again.body);
    const notOn = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: 'CXYZ0001', agent_id: s.jeff });
    check('channels: only to an agent the connection reaches', notOn.status === 422 && reason(notOn) === 'agent_not_on_connection', notOn.body);
    const missing = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: '#nowhere', agent_id: s.ops });
    check('channels: a name Slack does not know says to paste the id', missing.status === 422 && /paste the channel id/.test(missing.body?.error?.message ?? ''), missing.body);
    const flipped = await session(channelRoute.PATCH, 'PATCH', `${channelsPath}/${opsRoute?.id}`, { id: companyId, channelId: opsRoute?.id }, { listen: 'all' });
    const flippedBack = await session(channelRoute.PATCH, 'PATCH', `${channelsPath}/${opsRoute?.id}`, { id: companyId, channelId: opsRoute?.id }, { listen: 'mentions' });
    check('channels: the Owner switches a channel\'s listening', flipped.body?.data?.channels?.find((c: Loose) => c.id === opsRoute?.id)?.listen === 'all'
      && flippedBack.body?.data?.channels?.find((c: Loose) => c.id === opsRoute?.id)?.listen === 'mentions', [flipped.body, flippedBack.body]);
    const extra = await session(channelsRoute.POST, 'POST', channelsPath, { id: companyId }, { channel: 'CTMP0001', agent_id: s.ops });
    const extraId = extra.body?.data?.channels?.find((c: Loose) => c.channel_id === 'CTMP0001')?.id;
    const removedChannel = await session(channelRoute.DELETE, 'DELETE', `${channelsPath}/${extraId}`, { id: companyId, channelId: extraId });
    check('channels: and unmaps one', removedChannel.status === 200 && !removedChannel.body.data.channels.some((c: Loose) => c.channel_id === 'CTMP0001'), removedChannel.body);

    // ── Webhook endpoints ──────────────────────────────────────────────
    const unfiltered = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner, { name: 'All chat', url: 'https://hooks.example.test/all', events: ['chat.message'] });
    check('endpoints: chat.message without an agent filter is refused, 422', unfiltered.status === 422 && reason(unfiltered) === 'chat_message_needs_agent', unfiltered.body);
    const unfilteredSql = await db.query("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('All', 'https://hooks.example.test/all', 'whsec_a', '{chat.message}')")
      .then(() => null, (e: Error) => e.message);
    check('endpoints: and by the database', /chat.message goes only/.test(unfilteredSql ?? ''), unfilteredSql);
    const financeHook = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner, { name: 'Finance host', url: 'https://hooks.example.test/finance', events: ['chat.message'], member_id: s.finance });
    check('endpoints: chat.message on a company agent\'s endpoint', financeHook.status === 201, financeHook.body);
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id) VALUES ('Ops host', 'https://hooks.example.test/ops', 'whsec_ops', '{chat.message}', $1)`, [s.ops]);
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, member_id) VALUES ('Nova legacy', 'https://hooks.example.test/nova', 'whsec_nova', '{assistant.message}', $1)`, [s.anaAgent]);
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, assistant_setup_id) VALUES ('Assistant host', 'https://hooks.example.test/host', 'whsec_host', '{chat.message}', $1)`, [s.setup]);

    // ── The personal bot ───────────────────────────────────────────────
    const personalDm = slackEvent('U_ANA', 'Move my 3pm to Friday', 'D_ANA_P', 'im');
    const personalIn = await inbound(personalId, personalDm, signed(personalDm, PERSONAL_SECRET));
    const personalRow = await row(personalIn.body?.id);
    const legacy = await eventFor('assistant.message', personalIn.body?.id);
    const neutral = await eventFor('chat.message', personalIn.body?.id);
    check('personal: a DM goes to the sender\'s own assistant', personalIn.body?.status === 'notified' && personalRow?.agent_id === s.anaAgent && personalRow.member_id === s.ana, personalIn.body);
    check('personal: assistant.message is exactly what it was', JSON.stringify(Object.keys(legacy?.data ?? {}).sort()) === JSON.stringify(['agent_id', 'member_ids', 'message', 'person', 'read', 'reply', 'thread_ids'])
      && JSON.stringify(Object.keys(legacy.data.message).sort()) === JSON.stringify(['connection_id', 'conversation_id', 'created_at', 'id', 'provider', 'thread_id'])
      && legacy.data.read.path === `/api/v1/assistant/messages/${personalIn.body?.id}`, legacy);
    check('personal: chat.message beside it, ids only, kind personal', neutral?.data?.connection_kind === 'personal' && neutral.data.is_request === true && neutral.data.channel.direct === true
      && neutral.data.act_for === null && neutral.data.read.path === `/api/v1/chat/messages/${personalIn.body?.id}` && !JSON.stringify(neutral).includes('3pm'), neutral);
    const inChannel = slackEvent('U_ANA', 'hello all', 'C_GEN', 'channel');
    const personalChannel = await inbound(personalId, inChannel, signed(inChannel, PERSONAL_SECRET));
    check('personal: a channel is ignored', personalChannel.body?.status === 'ignored' && personalChannel.body.reason === 'personal_dm_only', personalChannel.body);

    // ── The company bot ────────────────────────────────────────────────
    const toCompany = async (user: string, text: string, channel: string, type: 'im' | 'channel', extraFields: Record<string, unknown> = {}) => {
      const body = slackEvent(user, text, channel, type, extraFields);
      const answer = await inbound(companyId, body, signed(body, COMPANY_SECRET));
      return { answer, body, record: answer.body?.id ? await row(answer.body.id) : null };
    };
    const dm = await toCompany('U_ANA', 'What did we ship this week?', 'D_ANA_C', 'im');
    check('company: a DM goes to the default agent, from Ana', dm.answer.body?.status === 'notified' && dm.record?.agent_id === s.ops && dm.record.member_id === s.ana
      && dm.record.route === 'direct' && dm.record.is_request === true && dm.record.is_direct === true, dm.record);
    const dmEvent = await eventFor('chat.message', dm.answer.body?.id);
    check('company: chat.message carries ids, kind, channel, request, and how to act for Ana', dmEvent?.data?.connection_kind === 'company' && dmEvent.data.agent_id === s.ops
      && dmEvent.data.is_request === true && dmEvent.data.channel.direct === true && dmEvent.data.route === 'direct' && Array.isArray(dmEvent.data.thread?.message_ids)
      && JSON.stringify(dmEvent.data.act_for?.body) === JSON.stringify({ provider: 'slack', external_id: 'U_ANA', workspace_id: 'T1' })
      && dmEvent.data.reply?.path === `/api/v1/chat/messages/${dm.answer.body?.id}/reply` && !JSON.stringify(dmEvent).includes('ship this week'), dmEvent);
    check('company: no assistant.message for a company agent', await eventFor('assistant.message', dm.answer.body?.id) === undefined);

    const botMention = await toCompany('U_ANA', '<@UBOTC01> any incidents today?', 'C_GEN', 'channel');
    check('company: a bot mention in an unmapped channel goes to the default', botMention.record?.agent_id === s.ops && botMention.record.route === 'default'
      && botMention.record.is_direct === false && botMention.record.text === 'any incidents today?', botMention.record);
    const named = await toCompany('U_ANA', '@Finance Bot what is our cash position?', 'C_GEN', 'channel');
    check('company: an agent named in a channel gets it', named.record?.agent_id === s.finance && named.record.route === 'mention' && named.record.is_request === true, named.record);
    // A conversation claim (20261127002000): follow-ups in a held thread go to the agent holding it.
    const v1ConvClaim = await import('../src/app/api/v1/chat/conversations/[id]/claim/route');
    const heldConv = named.record?.chat_conversation_id as string;
    const convLease = await v1(v1ConvClaim.POST, 'POST', `/api/v1/chat/conversations/${heldConv}/claim`, { id: heldConv }, s.keys.finance, { instance_id: 'fin-1' });
    const followInThread = await toCompany('U_ANA', '<@UBOTC01> and next quarter?', 'C_GEN', 'channel', { thread_ts: named.body.event.ts });
    check('claims: a follow-up in a held conversation goes to the agent holding it, not the default', convLease.status === 200
      && followInThread.record?.agent_id === s.finance && followInThread.record.chat_conversation_id === heldConv, { lease: convLease.body, record: followInThread.record });
    const namedInThread = await toCompany('U_ANA', '@Ops AI can you check too?', 'C_GEN', 'channel', { thread_ts: named.body.event.ts });
    check('claims: naming another agent still reaches it', namedInThread.record?.agent_id === s.ops && namedInThread.record.route === 'mention', namedInThread.record);
    await s.q('UPDATE pm.chat_conversations SET holder_agent_id = NULL, holder_instance = NULL, claim_expires_at = NULL WHERE id = $1', [heldConv]);
    const chatter = await toCompany('U_ANA', 'lunch at noon?', 'C_GEN', 'channel');
    check('company: chatter in an unmapped channel is not recorded', chatter.answer.body?.status === 'ignored' && chatter.record === null, chatter.answer.body);

    const context = await toCompany('U_ANA', 'the vendor invoice came in late again', 'CFIN0001', 'channel');
    const contextEvent = await eventFor('chat.message', context.answer.body?.id);
    check('listen all: chatter is context for the mapped agent, never a request', context.answer.body?.status === 'context' && context.record?.agent_id === s.finance
      && context.record.is_request === false && context.record.status === 'context' && context.record.member_id === s.ana, context.record);
    check('listen all: chat.message says it is context, with no reply and no act-for', contextEvent?.data?.is_request === false && contextEvent.data.reply === null
      && contextEvent.data.act_for === null && contextEvent.data.channel.listen === 'all' && contextEvent.data.channel.mapped_agent_id === s.finance && contextEvent.data.channel.name === '#finance', contextEvent);
    const ask = await toCompany('U_ANA', '<@UBOTC01> what is the balance?', 'CFIN0001', 'channel');
    check('listen all: a mention in the same channel is a request to the mapped agent', ask.answer.body?.status === 'notified' && ask.record?.agent_id === s.finance
      && ask.record.is_request === true && ask.record.route === 'channel', ask.record);
    const twin = { type: 'event_callback', team_id: 'T1', event_id: 'EvTwin', event: { ...ask.body.event, type: 'app_mention', channel_type: undefined } };
    const twinIn = await inbound(companyId, twin, signed(twin, COMPANY_SECRET));
    check('company: Slack\'s app_mention twin of a message is recorded once', twinIn.body?.status === 'duplicate'
      && await count("SELECT count(*)::int AS n FROM pm.chat_messages WHERE connection_id = $1 AND external_message_id = $2", [companyId, ask.body.event.ts]) === 1, twinIn.body);
    // The pair arriving at once: both pass the twin check, the database keeps one.
    const pairMessage = slackEvent('U_ANA', '<@UBOTC01> what came in today?', 'CFIN0001', 'channel');
    const pairMention = { type: 'event_callback', team_id: 'T1', event_id: `${pairMessage.event_id}m`, event: { ...pairMessage.event, type: 'app_mention', channel_type: undefined } };
    const pair = await Promise.all([
      inbound(companyId, pairMessage, signed(pairMessage, COMPANY_SECRET)),
      inbound(companyId, pairMention, signed(pairMention, COMPANY_SECRET)),
    ]);
    const pairRows = await s.q<{ id: string }>('SELECT id FROM pm.chat_messages WHERE connection_id = $1 AND external_message_id = $2', [companyId, pairMessage.event.ts]);
    const pairEvents = await count("SELECT count(*)::int AS n FROM pm.webhook_events WHERE event_type = 'chat.message' AND resource_id = ANY($1::uuid[])", [pairRows.map((r) => r.id)]);
    check('company: the message and its app_mention twin at once are recorded once, with one chat.message', pairRows.length === 1 && pairEvents === 1
      && pair.map((answer) => answer.body?.status).sort().join(',') === 'duplicate,notified', { pair: pair.map((answer) => answer.body), rows: pairRows.length, pairEvents });
    const opsChatter = await toCompany('U_ANA', 'deploy at 5', 'COPS0001', 'channel');
    const opsAsk = await toCompany('U_ANA', '<@UBOTC01> is staging up?', 'COPS0001', 'channel');
    check('listen mentions: chatter is not recorded, a mention goes to the mapped agent', opsChatter.answer.body?.status === 'ignored' && opsChatter.record === null
      && opsAsk.record?.agent_id === s.ops && opsAsk.record.route === 'channel', [opsChatter.answer.body, opsAsk.record]);

    providerCalls.length = 0;
    const strangerContext = await toCompany('U_STRANGER', 'anyone seen the Q3 numbers?', 'CFIN0001', 'channel');
    check('strangers: chatter in a listening channel is context with their provider id and no member', strangerContext.answer.body?.status === 'context'
      && strangerContext.record?.member_id === null && strangerContext.record.identity_id === null && strangerContext.record.external_user_id === 'U_STRANGER'
      && strangerContext.record.is_request === false && providerCalls.length === 0, strangerContext.record);
    const strangerAsk = await toCompany('U_STRANGER', '<@UBOTC01> send me the numbers', 'CFIN0001', 'channel');
    const strangerLine = posts()[0];
    check('strangers: a request in a channel gets "message me directly" in its thread, no link', strangerAsk.answer.body?.status === 'unrouted'
      && strangerLine?.body?.text === 'Message me directly to connect your account.' && strangerLine.body.thread_ts === strangerAsk.body.event.ts && strangerLine.body.channel === 'CFIN0001'
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 0, { body: strangerAsk.answer.body, strangerLine });
    providerCalls.length = 0;
    await toCompany('U_STRANGER', 'hi', 'D_STRANGER', 'im');
    check('strangers: a DM gets the one-time link, in the DM', posts()[0]?.body?.channel === 'D_STRANGER' && /\/link\/pl_[a-f0-9]{64}/.test(posts()[0]?.body?.text ?? '')
      && await count("SELECT count(*)::int AS n FROM pm.identity_link_requests WHERE external_id = 'U_STRANGER'") === 1, providerCalls);

    await runDispatch();
    check('webhook: chat.message reached the company agent\'s endpoint, signed, context included', ['notified', 'context'].every((kind) => deliveries.some((d) => d.url === 'https://hooks.example.test/finance'
      && d.headers.get('x-vm-event-type') === 'chat.message' && !!d.headers.get('x-vm-signature') && (kind === 'context' ? d.body?.data?.is_request === false : d.body?.data?.is_request === true))), deliveries.map((d) => d.url));
    check('webhook: the setup-scoped endpoint got the personal chat.message, and the legacy endpoint assistant.message',
      deliveries.some((d) => d.url === 'https://hooks.example.test/host' && d.body?.type === 'chat.message' && d.body?.data?.message?.id === personalIn.body?.id)
      && deliveries.some((d) => d.url === 'https://hooks.example.test/nova' && d.body?.type === 'assistant.message' && d.body?.data?.message?.id === personalIn.body?.id), deliveries.map((d) => [d.url, d.body?.type]));
    check('webhook: no company message reached a personal or setup endpoint', !deliveries.some((d) => ['https://hooks.example.test/host', 'https://hooks.example.test/nova'].includes(d.url)
      && d.body?.data?.connection_kind === 'company'));

    // ── Reading, and the sender as principal ───────────────────────────
    const askId = ask.answer.body?.id as string;
    const financeRead = await v1(v1Message.GET, 'GET', `/api/v1/chat/messages/${askId}`, { id: askId }, s.keys.finance);
    check('read: the company agent reads its message with the act-for body', financeRead.status === 200 && financeRead.body.data.text === 'what is the balance?'
      && financeRead.body.data.connection_kind === 'company' && financeRead.body.data.channel.listen === 'all' && financeRead.body.data.act_for?.path === '/api/v1/delegations'
      && financeRead.body.data.thread.some((item: Loose) => item.id === context.answer.body?.id && item.is_request === false), financeRead.body);
    const opsReads = await v1(v1Message.GET, 'GET', `/api/v1/chat/messages/${askId}`, { id: askId }, s.keys.ops);
    check('read: another agent reads it as missing', opsReads.status === 404, opsReads.body);
    const financeLegacy = await v1(legacyMessages.GET, 'GET', '/api/v1/assistant/messages', {}, s.keys.finance);
    check('read: the deprecated assistant routes stay personal only', financeLegacy.status === 403 && reason(financeLegacy) === 'not_a_personal_agent', financeLegacy.body);
    const anaLegacy = await v1(legacyMessage.GET, 'GET', `/api/v1/assistant/messages/${personalIn.body?.id}`, { id: personalIn.body?.id }, s.keys.anaAgent);
    check('read: and still serve the personal assistant', anaLegacy.status === 200 && anaLegacy.body.data.text === 'Move my 3pm to Friday', anaLegacy.body);
    const contextList = await v1(v1Messages.GET, 'GET', '/api/v1/chat/messages?status=context', {}, s.keys.finance);
    check('poll: context lists on its own, the stranger\'s too', contextList.status === 200 && [context.answer.body?.id, strangerContext.answer.body?.id]
      .every((id) => contextList.body.data.messages.some((m: Loose) => m.id === id && m.is_request === false)), contextList.body);

    const mint = async (key: string, externalId: string) => (await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, key, { provider: 'slack', external_id: externalId, workspace_id: 'T1' })).body?.data?.token as string;
    const anaPass = await mint(s.keys.finance, financeRead.body?.data?.act_for?.body?.external_id);
    const benPass = await mint(s.keys.finance, 'U_BEN');
    const ledgerAlone = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.secret}`, { id: s.secret }, s.keys.finance);
    const ledgerForAna = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.secret}`, { id: s.secret }, s.keys.finance, undefined, anaPass);
    const sharedForAna = await v1(v1Project.GET, 'GET', `/api/v1/projects/${s.shared}`, { id: s.shared }, s.keys.finance, undefined, anaPass);
    check('principal: acting for Ana, the bot reaches only what both reach', !!anaPass && ledgerAlone.status === 200 && ledgerForAna.status === 403 && sharedForAna.status === 200,
      [ledgerAlone.status, ledgerForAna.status, sharedForAna.status]);
    const noPass = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${askId}/reply`, { id: askId }, s.keys.finance, { text: 'About 40k.' });
    check('reply: a company request needs X-Act-For for its sender', noPass.status === 403 && reason(noPass) === 'act_for_required', noPass.body);
    const wrongPass = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${askId}/reply`, { id: askId }, s.keys.finance, { text: 'About 40k.' }, benPass);
    check('reply: a pass for someone else is refused', wrongPass.status === 403 && reason(wrongPass) === 'act_for_mismatch', wrongPass.body);
    providerCalls.length = 0;
    const replied = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${askId}/reply`, { id: askId }, s.keys.finance, { text: 'About 40k in checking.', also_send_to_channel: true }, anaPass);
    const replyPost = posts()[0];
    check('reply: threads under the message, also in the channel, under the agent\'s name and avatar', replied.status === 201 && replyPost?.body?.channel === 'CFIN0001'
      && replyPost.body.thread_ts === ask.body.event.ts && replyPost.body.reply_broadcast === true && replyPost.body.username === 'Finance Bot' && replyPost.body.icon_url === FINANCE_AVATAR
      && replyPost.auth === `Bearer ${COMPANY_TOKEN}` && (await row(askId)).status === 'replied', { replied: replied.body, replyPost });
    const toContext = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${context.answer.body?.id}/reply`, { id: context.answer.body?.id }, s.keys.finance, { text: 'Noted.' }, anaPass);
    const handleContext = await v1(v1Handled.POST, 'POST', `/api/v1/chat/messages/${context.answer.body?.id}/handled`, { id: context.answer.body?.id }, s.keys.finance);
    check('reply: context is never answered or handled, 409', toContext.status === 409 && reason(toContext) === 'not_a_request' && handleContext.status === 409, [toContext.body, handleContext.body]);
    const opsPass = await mint(s.keys.ops, 'U_ANA');
    providerCalls.length = 0;
    const privately = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${botMention.answer.body?.id}/reply`, { id: botMention.answer.body?.id }, s.keys.ops,
      { text: 'One incident, resolved at 9.', private: true, also_send_to_channel: true }, opsPass);
    const opened = providerCalls.find((call) => call.url.endsWith('/conversations.open'));
    const privatePost = posts()[0];
    check('reply: private goes to the sender by DM, never in the channel', privately.status === 201 && privately.body.data.private === true && opened?.body?.users === 'U_ANA'
      && privatePost?.body?.channel === 'D_PRIVATE_U_ANA' && !('thread_ts' in (privatePost?.body ?? {})) && !('reply_broadcast' in (privatePost?.body ?? {}))
      && privatePost?.body?.username === 'Ops AI', { privately: privately.body, opened, privatePost });
    providerCalls.length = 0;
    const personalReply = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${personalIn.body?.id}/reply`, { id: personalIn.body?.id }, s.keys.anaAgent, { text: 'Moved.' });
    check('reply: a personal assistant answers on the new route with no pass, under its own name', personalReply.status === 201 && posts()[0]?.body?.channel === 'D_ANA_P'
      && posts()[0]?.body?.username === "Ana's Assistant" && posts()[0]?.auth === `Bearer ${PERSONAL_TOKEN}`, { personalReply: personalReply.body, call: posts()[0] });

    // ── Once per hold, with the agent's name ───────────────────────────
    const ON_HOLD = "Ops AI is on hold right now and will answer when it's back.";
    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [s.ops]);
    providerCalls.length = 0;
    const held1 = await toCompany('U_ANA', 'status?', 'D_ANA_C', 'im');
    const held2 = await toCompany('U_ANA', 'hello?', 'D_ANA_C', 'im');
    check('on hold: a paused company agent still gets the message, and Ana hears why once', held1.answer.body?.status === 'notified' && held2.answer.body?.status === 'notified'
      && JSON.stringify(posts().map((call) => call.body.text)) === JSON.stringify([ON_HOLD]) && posts()[0].body.channel === 'D_ANA_C', providerCalls);
    providerCalls.length = 0;
    const heldInChannel = await toCompany('U_ANA', '<@UBOTC01> deploy?', 'COPS0001', 'channel');
    check('on hold: in a channel, the line threads under the message', posts().length === 1 && posts()[0].body.text === ON_HOLD && posts()[0].body.thread_ts === heldInChannel.body.event.ts, providerCalls);
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [s.ops]);
    await s.q("UPDATE pm.team_members SET status = 'suspended', suspended_by = $1, suspended_at = now() WHERE id = $2", [s.owner, s.finance]);
    providerCalls.length = 0;
    const toSuspended = await toCompany('U_ANA', '<@UBOTC01> payroll?', 'CFIN0001', 'channel');
    await toCompany('U_ANA', '<@UBOTC01> anyone?', 'CFIN0001', 'channel');
    check('suspended: recorded, never sent, and the line once with its name', toSuspended.answer.body?.status === 'unrouted' && toSuspended.record?.agent_id === s.finance
      && JSON.stringify(posts().map((call) => call.body.text)) === JSON.stringify(["Finance Bot can't answer right now. Try again later."]), providerCalls);
    await s.q("UPDATE pm.team_members SET status = 'active', suspended_by = NULL, suspended_at = NULL WHERE id = $1", [s.finance]);

    // ── MCP ────────────────────────────────────────────────────────────
    const financeTools = toolsFor({ access: (await resolveMemberAccess(service, s.finance))!, scopes: CHAT_SCOPES, readOnly: false, profile: 'generic' }).map((t) => t.name);
    const jeffTools = toolsFor({ access: (await resolveMemberAccess(service, s.jeff))!, scopes: ['notifications.manage_own', 'projects.read'], readOnly: false, profile: 'generic' }).map((t) => t.name);
    check('mcp: a company agent sees the chat tools; an agent that cannot act for people does not', ['list_chat_messages', 'get_chat_message', 'reply_in_chat', 'mark_chat_handled'].every((n) => financeTools.includes(n))
      && !jeffTools.some((n) => /chat/.test(n)), { financeTools: financeTools.filter((n) => /chat/.test(n)), jeffTools: jeffTools.filter((n) => /chat/.test(n)) });

    // ── My Assistant lists the personal bot only ───────────────────────
    const { myAssistantView } = await import('../src/lib/api/assistant');
    const anaView = await myAssistantView(service, s.ana, (await resolveMemberAccess(service, s.ana))!);
    check('my assistant: Ana links her chat through the personal bot, never the company one', anaView.connections.length === 1 && anaView.connections[0].id === personalId, anaView.connections);

    // ── Telegram: company groups ───────────────────────────────────────
    const telegram = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'telegram', kind: 'company', bot_token: TELEGRAM_TOKEN });
    const telegramId = telegram.body?.data?.id as string;
    const hook = providerCalls.find((call) => call.url.endsWith('/setWebhook'));
    await session(agentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${telegramId}/agents`, { id: telegramId }, { agent_ids: [s.ops], default_agent_id: s.ops });
    const group = { update_id: 900, message: { message_id: 31, from: { id: 5550001, username: 'ana' }, chat: { id: -300, type: 'supergroup' }, text: '@acme_company_bot status of the release?' } };
    const tgIn = await inbound(telegramId, group, { 'x-telegram-bot-api-secret-token': hook?.body?.secret_token });
    const tgRow = tgIn.body?.id ? await row(tgIn.body.id) : null;
    check('telegram: a mention of the bot in a group goes to the default agent', telegram.status === 201 && telegram.body.data.kind === 'company' && tgRow?.agent_id === s.ops && tgRow.route === 'default', { tg: telegram.body, tgIn: tgIn.body, tgRow });
    const tgPass = (await v1(v1Delegations.POST, 'POST', '/api/v1/delegations', {}, s.keys.ops, { provider: 'telegram', external_id: '5550001', workspace_id: null })).body?.data?.token;
    providerCalls.length = 0;
    const tgReply = await v1(v1Reply.POST, 'POST', `/api/v1/chat/messages/${tgIn.body?.id}/reply`, { id: tgIn.body?.id }, s.keys.ops, { text: 'Shipping at 4.' }, tgPass);
    const tgSent = providerCalls.find((call) => call.url.endsWith('/sendMessage'));
    check('telegram: the reply answers the message in the group, under the bot\'s own name', tgReply.status === 201 && tgSent?.body?.chat_id === '-300'
      && tgSent.body.reply_parameters?.message_id === 31 && !('username' in tgSent.body), { tgReply: tgReply.body, tgSent });

    check('logs: no token was ever written to the audit log', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE request_body::text LIKE '%xoxb%' OR request_body::text LIKE '%AAHdq%'") === 0);

    // ── The Owner's list: who may be picked, and agents taken off in one step ──
    const listed = await session(connectionsRoute.GET, 'GET', '/api/workspace/chat-connections');
    const companyView = (listed.body?.data?.connections ?? []).find((c: Loose) => c.id === companyId);
    const candidate = (id: string) => (companyView?.candidates ?? []).find((c: Loose) => c.id === id);
    check('picker: every company agent is offered with whether it may act for people; personal assistants are not', candidate(s.ops)?.can_act_for === true
      && candidate(s.jeff)?.can_act_for === false && !candidate(s.anaAgent), companyView?.candidates);
    const financeChannels = await count('SELECT count(*)::int AS n FROM pm.chat_channel_routes WHERE connection_id = $1 AND agent_id = $2', [companyId, s.finance]);
    const opsChannels = await count('SELECT count(*)::int AS n FROM pm.chat_channel_routes WHERE connection_id = $1 AND agent_id = $2', [companyId, s.ops]);
    const takenOff = await session(agentsRoute.PUT, 'PUT', agentsPath, { id: companyId }, { agent_ids: [s.ops], default_agent_id: s.ops });
    check('agents: taking one off removes it and its channel mappings together; the rest stay', takenOff.status === 200 && financeChannels > 0
      && await count('SELECT count(*)::int AS n FROM pm.chat_channel_routes WHERE connection_id = $1 AND agent_id = $2', [companyId, s.finance]) === 0
      && await count('SELECT count(*)::int AS n FROM pm.chat_channel_routes WHERE connection_id = $1 AND agent_id = $2', [companyId, s.ops]) === opsChannels
      && takenOff.body.data.agents.length === 1 && takenOff.body.data.agents[0].is_default === true, takenOff.body);
    const refusedAtomically = await s.q<Loose>('SELECT pm.set_chat_connection_agents($1, $2::uuid[], $3, $4)', [companyId, [s.ops], s.finance, s.owner]).then(() => null, (e: Error) => e.message);
    check('agents: the database refuses a default that is not one of them, changing nothing', /default agent must be one of the agents/.test(refusedAtomically ?? '')
      && await count('SELECT count(*)::int AS n FROM pm.chat_connection_agents WHERE connection_id = $1 AND is_default', [companyId]) === 1, refusedAtomically);
  } finally {
    // Let the dispatch kicked after the last write finish before the server goes.
    await new Promise((resolve) => setTimeout(resolve, 500));
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
