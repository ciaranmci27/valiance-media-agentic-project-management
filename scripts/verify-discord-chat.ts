/**
 * Discord as a chat app, end to end over the real routes (session routes
 * with a signed-in Owner, v1 routes with keys, the public inbound route, a
 * fake PostgREST over PGlite with the full schema, every Discord call
 * mocked, so nothing leaves the machine):
 * - The relay signature: a valid one passes; a bad one, a stale one and
 *   none are refused; the relay's own signer (relay/discord/sign.mjs)
 *   matches the app's check; a replay of the same message id records nothing.
 * - Normalising MESSAGE_CREATE: a DM, a server mention, a thread, a reply to
 *   the bot; bots, webhooks and system messages ignored.
 * - Connecting checks the token with GET /users/@me, stores the bot id and
 *   the application id, and answers the relay secret once; the relay's
 *   hello turns "Waiting for relay" into heard.
 * - Routing: a DM on the personal bot to the sender's assistant; on the
 *   company bot an agent named with @, listen all (context) and mentions
 *   only (ignored), a bot mention in an unmapped channel.
 * - Sending: a channel webhook with the agent's name and avatar (made once,
 *   cached sealed), the bot with the name in bold and message_reference
 *   where webhooks are refused, a private reply by DM, a reply in a thread.
 * - 429: Discord's retry_after is waited and the call tried again; a long
 *   one is refused as rate_limited.
 *
 *   npm run -s test:discord-chat
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { chatHttp, ChatProviderError, type ParsedInbound } from '../src/lib/chat/providers/adapter';
import { discordAdapter, discordTiming, relaySignatureHeader, RELAY_SIGNATURE_HEADER } from '../src/lib/chat/providers/discord';
import { routeCompany, type CompanyAgent } from '../src/lib/chat/inbound';
import { webhookTransport } from '../src/lib/webhooks/target';
import { CHAT_APPS, chatAppConnectable, createChatConnectionSchema, discordInviteUrl } from '../src/lib/chat/types';
import { signatureHeader as relaySigner, SIGNATURE_HEADER as RELAY_HEADER } from '../relay/discord/sign.mjs';

const APP_KEY = 'e'.repeat(64);
const PERSONAL_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.GpErSn.personalpersonalpersonalpersonal';
const COMPANY_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAy.GcOmPy.companycompanycompanycompanycomp';
const BAD_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAz.GbAdTk.badbadbadbadbadbadbadbadbadbadbad';
const PERSONAL_BOT = '900000000000000001';
const COMPANY_BOT = '900000000000000002';
const COMPANY_APP = '800000000000000002';
const ANA = '300000000000000001';
const STRANGER = '300000000000000009';
const FIN = '110000000000000001';
const OPS = '110000000000000002';
const GEN = '110000000000000003';
const NOHOOK = '110000000000000004';
const THREAD = '110000000000000005';
const ROTATE = '110000000000000006';
const GUILD = '700000000000000001';
const FINANCE_AVATAR = 'https://cdn.example.com/finance.png';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const OWNER = { id: '00000000-0000-4000-8000-00000000d001', email: 'olivia@example.com' };

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

// ── Discord, mocked ──────────────────────────────────────────────────────

const calls: { method: string; url: string; path: string; body: Loose; auth: string }[] = [];
const slept: number[] = [];
/** The next calls answer 429 with these retry_after seconds, in order. */
const limits: number[] = [];
let seq = 0;
/** Runs once while Discord is making the next channel webhook (an Owner acting mid-send). */
let duringWebhook: (() => Promise<void>) | null = null;

function installDiscord() {
  discordTiming.sleep = async (ms) => { slept.push(ms); };
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = String(init?.body ?? '');
    const body = raw ? JSON.parse(raw) : null;
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const path = url.replace('https://discord.com/api/v10', '');
    calls.push({ method, url, path, body, auth });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (limits.length) return json({ message: 'You are being rate limited.', retry_after: limits.shift(), global: false }, 429);
    const token = auth.replace(/^Bot /, '');
    if (method === 'GET' && path === '/users/@me') {
      if (token === PERSONAL_TOKEN) return json({ id: PERSONAL_BOT, username: 'acme-assistant', bot: true });
      if (token === COMPANY_TOKEN) return json({ id: COMPANY_BOT, username: 'acme-ai', global_name: 'Acme AI', bot: true });
      return json({ message: '401: Unauthorized', code: 0 }, 401);
    }
    if (method === 'GET' && path === '/oauth2/applications/@me') return json({ id: token === COMPANY_TOKEN ? COMPANY_APP : PERSONAL_BOT, name: 'Acme' });
    if (method === 'GET' && /^\/channels\/\d+$/.test(path)) return json({ id: path.split('/')[2], name: path.endsWith(FIN) ? 'finance' : 'ops', type: 0 });
    const hook = path.match(/^\/channels\/(\d+)\/webhooks$/);
    if (method === 'POST' && hook) {
      if (hook[1] === NOHOOK) return json({ message: 'Missing Permissions', code: 50013 }, 403);
      if (duringWebhook) {
        const run = duringWebhook;
        duringWebhook = null;
        await run();
      }
      seq++;
      return json({ id: `55500000000000000${seq}`, token: `hooktoken${seq}`, channel_id: hook[1] });
    }
    if (method === 'POST' && /^\/webhooks\/\d+\/[^/?]+\?wait=true/.test(path)) return json({ id: `66600000000000${++seq}` });
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) return json({ id: `77700000000000${++seq}` });
    if (method === 'POST' && path === '/users/@me/channels') return json({ id: `DM${body.recipient_id}`, type: 1 });
    if (method === 'DELETE' && path.startsWith('/webhooks/')) return new Response(null, { status: 204 });
    return json({ message: 'Unknown', code: 0 }, 404);
  };
}

// ── Pure ─────────────────────────────────────────────────────────────────

const SECRET = 'rsec_' + 'ab'.repeat(32);

function signed(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  return new Headers({ [RELAY_SIGNATURE_HEADER]: relaySignatureHeader(secret, body, at) });
}

function message(fields: Loose = {}, channel: Loose = null) {
  seq++;
  const d = {
    id: `12000000000000${String(seq).padStart(4, '0')}`, channel_id: GEN, guild_id: GUILD, type: 0, content: 'hello',
    author: { id: ANA, username: 'ana', global_name: 'Ana Lopez' }, mentions: [], ...fields,
  };
  return { v: 1, t: 'MESSAGE_CREATE', d, channel: channel ?? { id: d.channel_id, type: d.guild_id ? 0 : 1, parent_id: null } };
}

function pureChecks() {
  const body = JSON.stringify(message());
  const credentials = { relay_secret: SECRET, bot_token: COMPANY_TOKEN };
  check('signature: a valid relay signature passes', discordAdapter.verify({ headers: signed(body), body, credentials }));
  check('signature: the relay\'s own signer is what the app checks', RELAY_HEADER === RELAY_SIGNATURE_HEADER
    && discordAdapter.verify({ headers: new Headers({ [RELAY_HEADER]: relaySigner(SECRET, body) }), body, credentials }));
  check('signature: another secret is refused', !discordAdapter.verify({ headers: signed(body, 'rsec_' + 'cd'.repeat(32)), body, credentials }));
  check('signature: a changed body is refused', !discordAdapter.verify({ headers: signed(body), body: body.replace('hello', 'hellO'), credentials }));
  check('signature: six minutes old is refused, four is fine', !discordAdapter.verify({ headers: signed(body, SECRET, Math.floor(Date.now() / 1000) - 360), body, credentials })
    && discordAdapter.verify({ headers: signed(body, SECRET, Math.floor(Date.now() / 1000) - 240), body, credentials }));
  check('signature: none, or a connection without a secret, is refused', !discordAdapter.verify({ headers: new Headers(), body, credentials })
    && !discordAdapter.verify({ headers: signed(body), body, credentials: { bot_token: COMPANY_TOKEN } }));

  const parse = (payload: unknown) => discordAdapter.parse(JSON.stringify(payload), new Headers()) as Loose;
  const dm = parse(message({ guild_id: undefined, channel_id: '400000000000000001', content: 'Move my 3pm' }));
  check('normalise: a DM is direct and addressed, its channel the conversation', dm.kind === 'message' && dm.direct === true && dm.addressed === true
    && dm.conversationId === '400000000000000001' && dm.threadId === null && dm.userId === ANA && dm.userHandle === '@ana' && dm.dedupeKey === `message:${dm.messageId}`, dm);
  const mention = parse(message({ content: `<@${COMPANY_BOT}> any incidents, <@!${ANA}>?`, mentions: [{ id: COMPANY_BOT, username: 'acme-ai', bot: true }, { id: ANA, username: 'ana', global_name: 'Ana Lopez' }] }));
  check('normalise: a server mention lists the bot, drops its token, names people', mention.kind === 'message' && mention.direct === false && mention.addressed === false
    && mention.mentions.includes(COMPANY_BOT) && mention.text === 'any incidents, @Ana Lopez?', mention);
  const reply = parse(message({ type: 19, content: 'and the second one?', referenced_message: { id: '1', author: { id: COMPANY_BOT, bot: true }, application_id: COMPANY_APP } }));
  check('normalise: a reply to the bot, or to an agent\'s webhook message, counts as its mention', reply.mentions.includes(COMPANY_BOT) && reply.mentions.includes(COMPANY_APP), reply);
  const inThread = parse(message({ channel_id: THREAD }, { id: THREAD, type: 11, parent_id: FIN }));
  check('normalise: a thread belongs to its parent channel, the thread as thread id', inThread.conversationId === FIN && inThread.threadId === THREAD, inThread);
  check('normalise: bots (itself too), webhooks and system messages are ignored', parse(message({ author: { id: COMPANY_BOT, username: 'acme-ai', bot: true } })).reason === 'not_a_person'
    && parse(message({ webhook_id: '5' })).reason === 'not_a_person' && parse(message({ type: 7 })).reason === 'message_type');
  check('normalise: nothing to read (no Message Content) is ignored', parse(message({ content: '' })).reason === 'empty' && parse(message({ content: `<@${COMPANY_BOT}>`, mentions: [{ id: COMPANY_BOT, bot: true }] })).reason === 'empty');
  check('normalise: the relay\'s hello is a ping', (discordAdapter.parse(JSON.stringify({ v: 1, t: 'RELAY_READY' }), new Headers()) as ParsedInbound).kind === 'ping');

  // Routing reads what the adapter gives: under listen all a plain message is context, under mentions it is ignored.
  const agent = (id: string, name: string, isDefault = false): CompanyAgent => ({ id, name, is_default: isDefault, row: { id, name } });
  const agents = [agent('ops', 'Ops AI', true), agent('fin', 'Finance Bot')];
  const plain = parse(message({ channel_id: FIN, content: 'invoice came in late' }));
  check('routing: a server message without a mention is context under listen all', routeCompany({ direct: plain.direct, botMentioned: false, text: plain.text, agents, channel: { agent_id: 'fin', listen: 'all' } }).kind === 'context');
  check('routing: and ignored under mentions only', routeCompany({ direct: plain.direct, botMentioned: false, text: plain.text, agents, channel: { agent_id: 'fin', listen: 'mentions' } }).kind === 'ignore');

  check('chat apps: Discord connects now', chatAppConnectable('discord') && CHAT_APPS.some((app) => app.provider === 'discord' && app.available));
  check('connect form: a Discord token is taken, a Slack one is not', createChatConnectionSchema.safeParse({ provider: 'discord', bot_token: COMPANY_TOKEN }).success
    && !createChatConnectionSchema.safeParse({ provider: 'discord', bot_token: 'xoxb-1111-2222-nope' }).success);
  check('invite: a company bot asks for Manage Webhooks, a personal one for nothing', discordInviteUrl(COMPANY_APP, 'company').endsWith('permissions=275414846464')
    && discordInviteUrl(COMPANY_APP, 'personal').endsWith('permissions=0') && discordInviteUrl(COMPANY_APP, 'company').includes(`client_id=${COMPANY_APP}&scope=bot`));
}

async function rateLimitChecks() {
  installDiscord();
  calls.length = 0; slept.length = 0;
  limits.push(0.25);
  const sent = await discordAdapter.send({ bot_token: COMPANY_TOKEN }, { conversationId: GEN, threadId: null, text: 'hi' });
  const posts = calls.filter((call) => call.path === `/channels/${GEN}/messages`);
  check('429: waits retry_after, then sends once more', posts.length === 2 && JSON.stringify(slept) === JSON.stringify([250]) && !!sent.externalMessageId, { posts: posts.length, slept });
  calls.length = 0; slept.length = 0;
  limits.push(30);
  const long = await discordAdapter.send({ bot_token: COMPANY_TOKEN }, { conversationId: GEN, threadId: null, text: 'hi' }).then(() => null, (error) => error);
  check('429: a long wait is refused as rate_limited, without waiting', long instanceof ChatProviderError && long.code === 'rate_limited' && slept.length === 0 && calls.length === 1, long?.message);
  limits.length = 0;
}

// ── Seed ─────────────────────────────────────────────────────────────────

const CHAT_SCOPES = ['notifications.manage_own', 'projects.read', 'tasks.read', 'agents.act_for'];
const TEMPLATE_SCOPES = ['tasks.read', 'tasks.create', 'projects.read', 'notifications.manage_own'];

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
    return (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template, avatar) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, email, role, extra.delegateOf ?? null, extra.delegateOf ? 'personal-assistant' : null, extra.avatar ?? '']))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [OWNER.id, OWNER.email]);
  await q('UPDATE pm.team_members SET auth_user_id = $1, email = $2 WHERE id = $3', [OWNER.id, OWNER.email, owner]);
  const ana = await member('Ana Lopez', 'member');
  const anaAgent = await member('Nova', 'agent', { delegateOf: ana });
  const ops = await member('Ops AI', 'agent');
  const finance = await member('Finance Bot', 'agent', { avatar: FINANCE_AVATAR });
  for (const m of [ops, finance]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow') ON CONFLICT DO NOTHING", [m]);
  }
  const key = async (memberId: string, scopes: string[]) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes]);
    return secretKey;
  };
  const keys = { ops: await key(ops, CHAT_SCOPES), finance: await key(finance, CHAT_SCOPES), anaAgent: await key(anaAgent, TEMPLATE_SCOPES) };
  await q("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'discord', $2, now(), 'link')", [ana, ANA]);
  return { q, owner, ana, anaAgent, ops, finance, keys };
}

async function main() {
  pureChecks();
  await rateLimitChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  installSession(server.url);
  installDiscord();
  const realTransport = { ...webhookTransport };
  webhookTransport.post = async () => ({ status: 200, text: 'ok' });

  try {
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const connectionRoute = await import('../src/app/api/workspace/chat-connections/[id]/route');
    const agentsRoute = await import('../src/app/api/workspace/chat-connections/[id]/agents/route');
    const channelsRoute = await import('../src/app/api/workspace/chat-connections/[id]/channels/route');
    const inboundRoute = await import('../src/app/api/chat/inbound/[id]/route');
    const v1Reply = await import('../src/app/api/v1/chat/messages/[id]/reply/route');
    const v1Delegations = await import('../src/app/api/v1/delegations/route');
    const { openCredentials } = await import('../src/lib/chat/connections');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, path: string, params: Record<string, string>, apiKey: string, body: unknown, actFor?: string) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor ? { 'x-act-for': actFor } : {}) }, body: JSON.stringify(body),
      }), { params: Promise.resolve(params) } as never));
    const post = async (connectionId: string, payload: unknown, headers: (raw: string) => Record<string, string>) => {
      const raw = JSON.stringify(payload);
      return read(await inboundRoute.POST(new Request(`https://pm.example.com/api/chat/inbound/${connectionId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers(raw) }, body: raw,
      }), { params: Promise.resolve({ id: connectionId }) }));
    };
    const relay = (secret: string) => (raw: string) => ({ [RELAY_SIGNATURE_HEADER]: relaySignatureHeader(secret, raw) });
    const row = async (id: string) => (await s.q<Loose>('SELECT * FROM pm.chat_messages WHERE id = $1', [id]))[0];
    const connRow = async (id: string) => (await s.q<Loose>('SELECT * FROM pm.chat_connections WHERE id = $1', [id]))[0];
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;

    // ── Connect ────────────────────────────────────────────────────────
    const bad = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'discord', bot_token: BAD_TOKEN });
    check('connect: a token Discord refuses is not saved, 422', bad.status === 422 && reason(bad) === 'provider_refused' && (await s.q('SELECT 1 FROM pm.chat_connections')).length === 0, bad.body);
    calls.length = 0;
    const personal = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'discord', bot_token: PERSONAL_TOKEN });
    const personalId = personal.body?.data?.id as string;
    const personalSecret = personal.body?.data?.relay_secret as string;
    const personalRow = await connRow(personalId);
    const personalCreds = personalRow ? openCredentials(personalRow) : null;
    check('connect: the token is checked with GET /users/@me and the bot id stored', personal.status === 201 && personalRow?.external_bot_id === PERSONAL_BOT
      && personalRow.bot_handle === '@acme-assistant' && calls.some((call) => call.method === 'GET' && call.path === '/users/@me' && call.auth === `Bot ${PERSONAL_TOKEN}`), { body: personal.body, personalRow });
    check('connect: the relay secret is answered once and stored sealed with the token', /^rsec_[a-f0-9]{64}$/.test(personalSecret ?? '') && personalCreds?.relay_secret === personalSecret
      && personalCreds?.bot_token === PERSONAL_TOKEN && personalCreds?.use_webhooks === '0' && !String(personalRow.credentials).includes(PERSONAL_TOKEN), personalCreds && Object.keys(personalCreds));
    const company = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'discord', kind: 'company', bot_token: COMPANY_TOKEN });
    const companyId = company.body?.data?.id as string;
    const companySecret = company.body?.data?.relay_secret as string;
    const companyRow = await connRow(companyId);
    check('connect: a company bot keeps the application id as its workspace and uses webhooks', company.status === 201 && companyRow?.external_workspace_id === COMPANY_APP
      && companyRow.external_bot_id === COMPANY_BOT && openCredentials(companyRow).use_webhooks === '1' && openCredentials(companyRow).application_id === COMPANY_APP, company.body);
    const listed = await session(connectionsRoute.GET, 'GET', '/api/workspace/chat-connections');
    check('connect: the list never carries the secret; nothing heard yet (Waiting for relay)', listed.status === 200 && !JSON.stringify(listed.body).includes('rsec_')
      && listed.body.data.connections.every((c: Loose) => c.last_inbound_at === null), listed.body);

    // ── The relay signature at the door ────────────────────────────────
    const hello = { v: 1, t: 'RELAY_READY', d: { bot_id: PERSONAL_BOT, guilds: 1 } };
    const unsigned = await post(personalId, hello, () => ({}));
    const wrong = await post(personalId, hello, relay(companySecret));
    const stale = await post(personalId, hello, (raw) => ({ [RELAY_SIGNATURE_HEADER]: relaySignatureHeader(personalSecret, raw, Math.floor(Date.now() / 1000) - 600) }));
    check('door: unsigned, another connection\'s secret and stale are all 401, nothing heard', [unsigned, wrong, stale].every((answer) => answer.status === 401)
      && (await connRow(personalId)).last_inbound_at === null, [unsigned, wrong, stale].map((a) => a.status));
    const heard = await post(personalId, hello, relay(personalSecret));
    check('door: the relay\'s hello is heard, so the row reads Connected', heard.status === 200 && heard.body?.status === 'ok' && (await connRow(personalId)).last_inbound_at !== null, heard.body);

    // ── The personal bot ───────────────────────────────────────────────
    const dm = message({ guild_id: undefined, channel_id: '400000000000000001', content: 'Move my 3pm to Friday' });
    const dmIn = await post(personalId, dm, relay(personalSecret));
    const dmRow = dmIn.body?.id ? await row(dmIn.body.id) : null;
    check('personal: a DM reaches the sender\'s own assistant', ['pending', 'notified'].includes(dmIn.body?.status) && dmRow?.agent_id === s.anaAgent && dmRow.member_id === s.ana
      && dmRow.external_message_id === dm.d.id && dmRow.dedupe_key === `message:${dm.d.id}`, { body: dmIn.body, dmRow });
    const replay = await post(personalId, dm, relay(personalSecret));
    check('door: a replay of the same message id, freshly signed, records nothing', replay.status === 200 && replay.body?.status === 'duplicate'
      && (await s.q('SELECT 1 FROM pm.chat_messages WHERE external_message_id = $1', [dm.d.id])).length === 1, replay.body);
    const inServer = await post(personalId, message({ content: 'hello all' }), relay(personalSecret));
    check('personal: a server message is never its business', inServer.body?.status === 'ignored' && inServer.body.reason === 'personal_dm_only', inServer.body);
    calls.length = 0;
    const personalReply = await v1(v1Reply.POST, `/api/v1/chat/messages/${dmIn.body?.id}/reply`, { id: dmIn.body?.id }, s.keys.anaAgent, { text: 'Moved.' });
    const personalSend = calls.find((call) => call.method === 'POST' && call.path.endsWith('/messages'));
    check('send: a personal reply goes as the bot in the DM, the assistant\'s name in bold, no webhook', personalReply.status === 201 && personalSend?.path === '/channels/400000000000000001/messages'
      && personalSend.body.content === '**Nova**\nMoved.' && personalSend.auth === `Bot ${PERSONAL_TOKEN}` && !('message_reference' in personalSend.body)
      && !calls.some((call) => call.path.includes('/webhooks')), { personalReply: personalReply.body, personalSend });

    // ── The company bot ────────────────────────────────────────────────
    await session(agentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${companyId}/agents`, { id: companyId }, { agent_ids: [s.ops, s.finance], default_agent_id: s.ops });
    const mappedFin = await session(channelsRoute.POST, 'POST', `/api/workspace/chat-connections/${companyId}/channels`, { id: companyId }, { channel: FIN, agent_id: s.finance, listen: 'all' });
    await session(channelsRoute.POST, 'POST', `/api/workspace/chat-connections/${companyId}/channels`, { id: companyId }, { channel: OPS, agent_id: s.ops });
    check('channels: a Discord channel id maps, named by Discord', mappedFin.status === 201 && mappedFin.body.data.channels.some((c: Loose) => c.channel_id === FIN && c.channel_name === '#finance'), mappedFin.body);
    const toCompany = async (fields: Loose, channel: Loose = null, secret = companySecret) => {
      const payload = message(fields, channel);
      const answer = await post(companyId, payload, relay(secret));
      return { answer, payload, record: answer.body?.id ? await row(answer.body.id) : null };
    };
    const named = await toCompany({ channel_id: GEN, content: '@Finance Bot what is our cash position?' });
    check('company: an agent named with @ gets the request', named.record?.agent_id === s.finance && named.record.route === 'mention' && named.record.is_request === true && named.record.member_id === s.ana, named.record);
    const botMention = await toCompany({ channel_id: GEN, content: `<@${COMPANY_BOT}> any incidents today?`, mentions: [{ id: COMPANY_BOT, username: 'acme-ai', bot: true }] });
    check('company: a bot mention in an unmapped channel goes to the default', botMention.record?.agent_id === s.ops && botMention.record.route === 'default' && botMention.record.text === 'any incidents today?', botMention.record);
    const context = await toCompany({ channel_id: FIN, content: 'the vendor invoice came in late again' });
    check('company: listen all records a plain message as context', context.answer.body?.status === 'context' && context.record?.is_request === false && context.record.agent_id === s.finance, context.record);
    const quiet = await toCompany({ channel_id: OPS, content: 'deploy at 5' });
    check('company: mentions only ignores a plain message, records nothing', quiet.answer.body?.status === 'ignored' && quiet.record === null, quiet.answer.body);
    const threaded = await toCompany({ channel_id: THREAD, content: `<@${COMPANY_BOT}> numbers for Q3?`, mentions: [{ id: COMPANY_BOT, bot: true }] }, { id: THREAD, type: 11, parent_id: FIN });
    check('company: a thread routes like its parent channel', threaded.record?.agent_id === s.finance && threaded.record.route === 'channel' && threaded.record.conversation_id === FIN && threaded.record.thread_id === THREAD, threaded.record);
    calls.length = 0;
    const stranger = await toCompany({ channel_id: GEN, content: `<@${COMPANY_BOT}> send me the numbers`, author: { id: STRANGER, username: 'drifter' }, mentions: [{ id: COMPANY_BOT, bot: true }] });
    const strangerSend = calls.find((call) => call.path.endsWith('/messages'));
    check('company: a stranger asking in a channel hears "message me directly", as a reply to them', stranger.answer.body?.status === 'unrouted'
      && strangerSend?.body?.content === 'Message me directly to connect your account.' && strangerSend.body.message_reference?.message_id === stranger.payload.d.id, strangerSend);

    // ── Replies ────────────────────────────────────────────────────────
    const mint = async (apiKey: string) => (await v1(v1Delegations.POST, '/api/v1/delegations', {}, apiKey, { provider: 'discord', external_id: ANA, workspace_id: null })).body?.data?.token as string;
    const financePass = await mint(s.keys.finance);
    const opsPass = await mint(s.keys.ops);
    calls.length = 0;
    const viaHook = await v1(v1Reply.POST, `/api/v1/chat/messages/${named.answer.body?.id}/reply`, { id: named.answer.body?.id }, s.keys.finance, { text: 'About 40k in checking.', also_send_to_channel: true }, financePass);
    const made = calls.filter((call) => call.method === 'POST' && call.path === `/channels/${GEN}/webhooks`);
    const hookPost = calls.find((call) => call.path.startsWith('/webhooks/'));
    check('send: a company reply goes through a channel webhook under the agent\'s name and avatar, mentioning the asker', viaHook.status === 201 && made.length === 1
      && made[0].auth === `Bot ${COMPANY_TOKEN}` && /\?wait=true$/.test(hookPost?.path ?? '') && hookPost?.body?.username === 'Finance Bot' && hookPost.body.avatar_url === FINANCE_AVATAR
      && hookPost.body.content === `<@${ANA}> About 40k in checking.` && JSON.stringify(hookPost.body.allowed_mentions) === JSON.stringify({ parse: [], users: [ANA] }) && hookPost.auth === '', { viaHook: viaHook.body, calls });
    const cached = openCredentials(await connRow(companyId));
    check('send: the webhook is cached in the sealed credentials, the relay secret kept', /^\d+\/hooktoken\d+$/.test(cached[`webhook:${GEN}`] ?? '') && cached.relay_secret === companySecret, Object.keys(cached));
    calls.length = 0;
    const second = await v1(v1Reply.POST, `/api/v1/chat/messages/${botMention.answer.body?.id}/reply`, { id: botMention.answer.body?.id }, s.keys.ops, { text: 'None today.' }, opsPass);
    check('send: the next reply in that channel reuses it, under the other agent\'s name', second.status === 201 && !calls.some((call) => call.path.endsWith('/webhooks'))
      && calls.find((call) => call.path.startsWith('/webhooks/'))?.body?.username === 'Ops AI', calls);
    calls.length = 0;
    const inThreadReply = await v1(v1Reply.POST, `/api/v1/chat/messages/${threaded.answer.body?.id}/reply`, { id: threaded.answer.body?.id }, s.keys.finance, { text: 'Q3 is in the deck.' }, financePass);
    const threadHook = calls.find((call) => call.path.startsWith('/webhooks/'));
    check('send: a reply in a thread posts in the thread through the parent\'s webhook', inThreadReply.status === 201 && calls.some((call) => call.path === `/channels/${FIN}/webhooks`)
      && (threadHook?.path ?? '').endsWith(`?wait=true&thread_id=${THREAD}`) && threadHook?.body?.content === 'Q3 is in the deck.', calls);

    const noHook = await toCompany({ channel_id: NOHOOK, content: `<@${COMPANY_BOT}> who is on call?`, mentions: [{ id: COMPANY_BOT, bot: true }] });
    calls.length = 0;
    const fallback = await v1(v1Reply.POST, `/api/v1/chat/messages/${noHook.answer.body?.id}/reply`, { id: noHook.answer.body?.id }, s.keys.ops, { text: 'Ben is.' }, opsPass);
    const fallbackPost = calls.find((call) => call.path === `/channels/${NOHOOK}/messages`);
    check('send: without Manage Webhooks it goes as the bot, a threaded reply (message_reference) with the name in bold', fallback.status === 201
      && fallbackPost?.body?.content === '**Ops AI**\nBen is.' && fallbackPost.body.message_reference?.message_id === noHook.payload.d.id
      && JSON.stringify(fallbackPost.body.allowed_mentions) === JSON.stringify({ parse: ['users'], replied_user: true }), { fallback: fallback.body, calls });
    check('send: the refusal is remembered, so the next reply does not ask again within the hour', /^none\/\d+$/.test(openCredentials(await connRow(companyId))[`webhook:${NOHOOK}`] ?? ''));

    calls.length = 0;
    const privately = await v1(v1Reply.POST, `/api/v1/chat/messages/${context.answer.body?.id}/reply`, { id: context.answer.body?.id }, s.keys.finance, { text: 'x' }, financePass);
    check('send: context is never answered', privately.status === 409 && calls.length === 0, privately.body);
    const ask = await toCompany({ channel_id: FIN, content: `<@${COMPANY_BOT}> payroll date?`, mentions: [{ id: COMPANY_BOT, bot: true }] });
    calls.length = 0;
    const dmReply = await v1(v1Reply.POST, `/api/v1/chat/messages/${ask.answer.body?.id}/reply`, { id: ask.answer.body?.id }, s.keys.finance, { text: 'The 28th.', private: true }, financePass);
    const opened = calls.find((call) => call.path === '/users/@me/channels');
    const dmPost = calls.find((call) => call.path === `/channels/DM${ANA}/messages`);
    check('send: private opens the DM and sends there, as the bot with the name in bold, never in the channel', dmReply.status === 201 && dmReply.body.data.private === true
      && opened?.body?.recipient_id === ANA && dmPost?.body?.content === '**Finance Bot**\nThe 28th.' && !('message_reference' in dmPost.body)
      && !calls.some((call) => call.path.startsWith('/webhooks/') || call.path === `/channels/${FIN}/messages`), { dmReply: dmReply.body, calls });

    // ── A new relay secret ─────────────────────────────────────────────
    const renewed = await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${companyId}`, { id: companyId }, { new_relay_secret: true });
    const fresh = renewed.body?.data?.relay_secret as string;
    const oldNow = await post(companyId, hello, relay(companySecret));
    const newNow = await post(companyId, hello, relay(fresh));
    check('relay secret: a new one is answered once; the old one stops working, the webhooks stay', renewed.status === 200 && /^rsec_/.test(fresh ?? '') && fresh !== companySecret
      && oldNow.status === 401 && newNow.status === 200 && !!openCredentials(await connRow(companyId))[`webhook:${GEN}`], [renewed.body, oldNow.status, newNow.status]);

    // A relay secret rotated while a send is making a webhook: the send stores only its webhook.
    const midSend = await toCompany({ channel_id: ROTATE, content: `<@${COMPANY_BOT}> status?`, mentions: [{ id: COMPANY_BOT, bot: true }] }, null, fresh);
    let rotated = '';
    duringWebhook = async () => {
      rotated = (await session(connectionRoute.PATCH, 'PATCH', `/api/workspace/chat-connections/${companyId}`, { id: companyId }, { new_relay_secret: true })).body?.data?.relay_secret ?? '';
    };
    const midReply = await v1(v1Reply.POST, `/api/v1/chat/messages/${midSend.answer.body?.id}/reply`, { id: midSend.answer.body?.id }, s.keys.ops, { text: 'All green.' }, opsPass);
    const afterRotate = openCredentials(await connRow(companyId));
    const rotatedNow = await post(companyId, hello, relay(rotated));
    const freshNow = await post(companyId, hello, relay(fresh));
    check('relay secret: one rotated during a send survives the send, and the send\'s webhook is saved', midReply.status === 201 && /^rsec_/.test(rotated) && rotated !== fresh
      && afterRotate.relay_secret === rotated && /^\d+\/hooktoken\d+$/.test(afterRotate[`webhook:${ROTATE}`] ?? '') && !!afterRotate[`webhook:${GEN}`]
      && rotatedNow.status === 200 && freshNow.status === 401, { midReply: midReply.body, rotated: !!rotated, keys: Object.keys(afterRotate), rotatedNow: rotatedNow.status, freshNow: freshNow.status });

    // ── Disconnect ─────────────────────────────────────────────────────
    calls.length = 0;
    const gone = await session(connectionRoute.DELETE, 'DELETE', `/api/workspace/chat-connections/${companyId}`, { id: companyId });
    check('disconnect: the channel webhooks it made are deleted', gone.status === 200 && calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/webhooks/')).length === 3, calls);
    check('logs: no token or relay secret reached the audit log', (await s.q("SELECT 1 FROM pm.api_audit_log WHERE request_body::text LIKE '%rsec_%' OR request_body::text LIKE '%MTAw%'")).length === 0);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
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
