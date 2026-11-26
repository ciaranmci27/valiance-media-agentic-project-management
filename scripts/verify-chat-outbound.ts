/**
 * Agents start chat conversations, and people send them files
 * (20261125001500_chat_outbound_media.sql), end to end over the real routes
 * (session routes with a signed-in Owner, v1 routes with keys, the public
 * inbound route, a fake PostgREST over PGlite with the full schema, every
 * Slack, Telegram and Discord call mocked, so nothing leaves the machine):
 * - The migration, run twice on the schema before it, matches schema.sql.
 * - POST /api/v1/chat/messages: a personal assistant DMs its own person and
 *   no one else; a company agent posts only in a channel mapped to it, and
 *   DMs a member only while acting for them or with chat.notify (on both the
 *   agent and the key); the hourly limits per agent and per recipient; a
 *   paused agent gets 423; the link is rendered the provider's way.
 * - A reply to a started message (a Slack thread, a DM) goes back to the
 *   same agent, with in_reply_to naming it.
 * - Telegram photos, voice notes and documents, Slack files and Discord
 *   attachments become attachments (a caption is the text, a file alone is a
 *   request); GET .../attachments/{n} proxies the bytes without a token or
 *   provider address in any answer, only for the routed agent, never past
 *   20 MB.
 *
 *   npm run -s test:chat-outbound
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
import { slackAdapter, slackSignature } from '../src/lib/chat/providers/slack';
import { telegramAdapter } from '../src/lib/chat/providers/telegram';
import { discordAdapter, relaySignatureHeader, RELAY_SIGNATURE_HEADER } from '../src/lib/chat/providers/discord';
import { chatHttp, type ParsedInbound } from '../src/lib/chat/providers/adapter';
import { routeCompany, type CompanyAgent } from '../src/lib/chat/inbound';
import { webhookTransport } from '../src/lib/webhooks/target';
import { CHAT_ATTACHMENT_MAX_BYTES } from '../src/lib/chat/types';

const MIGRATION = '20261125001500_chat_outbound_media.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- CHAT OUTBOUND AND MEDIA (20261125001500_chat_outbound_media.sql)';
const APP_KEY = 'f'.repeat(64);
const PERSONAL_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f91';
const COMPANY_SECRET = '0f9e8d7c6b5a49382716051f2e3d4c5c';
const PERSONAL_TOKEN = 'xoxb-1111-2222-personaloutbound';
const COMPANY_TOKEN = 'xoxb-3333-4444-companyoutbound';
const TELEGRAM_TOKEN = '777000222:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDpers';
const DISCORD_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDA5.GcOmPy.companycompanycompanycompanycomp';
const DISCORD_BOT = '900000000000000009';
const DISCORD_APP = '800000000000000009';
const ANA_DISCORD = '300000000000000001';
const DISCORD_CHANNEL = '110000000000000007';
const NOVA_AVATAR = 'https://cdn.example.com/nova.png';
const FINANCE_AVATAR = 'https://cdn.example.com/finance.png';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SLACK_BYTES = Buffer.from('PNGDATA');
const VOICE_BYTES = Buffer.from('OGGVOICE');
const SLACK_FILE = 'https://files.slack.com/files-pri/T1-F1/download/shot.png';
const SLACK_REDIRECT_FILE = 'https://files.slack.com/files-pri/T1-F2/download/moved.png';
const DISCORD_OLD_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=old';
const DISCORD_NEW_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=new';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const OWNER = { id: '00000000-0000-4000-8000-00000000f001', email: 'olivia@example.com' };

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

// ── Providers, mocked ────────────────────────────────────────────────────

const providerCalls: { method: string; url: string; body: Loose; auth: string }[] = [];
let seq = 0;

function installProviders() {
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = String(init?.body ?? '');
    let body: Loose;
    try { body = JSON.parse(raw || '{}'); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    providerCalls.push({ method, url, body, auth });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const bytes = (data: Buffer, type: string, extra: Record<string, string> = {}) =>
      new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': type, 'content-length': String(data.length), ...extra } });
    // Slack
    if (url.endsWith('/auth.test')) {
      return json(auth.includes(PERSONAL_TOKEN)
        ? { ok: true, team_id: 'T1', team: 'Acme', user: 'assistant', user_id: 'UBOTP01' }
        : { ok: true, team_id: 'T1', team: 'Acme', user: 'acme-ai', user_id: 'UBOTC01' });
    }
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: `1800000000.${String(++seq).padStart(6, '0')}` });
    if (url.endsWith('/conversations.open')) return json({ ok: true, channel: { id: `D_PRIVATE_${body.users}` } });
    if (url.endsWith('/conversations.info')) return json({ ok: true, channel: { id: body.channel, name: body.channel === 'CFIN0001' ? 'finance' : 'ops' } });
    if (url === SLACK_FILE) return bytes(SLACK_BYTES, 'image/png');
    if (url === SLACK_REDIRECT_FILE) return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
    if (url.startsWith('https://evil.example.com')) return bytes(Buffer.from('nope'), 'text/plain');
    // Telegram
    if (url.endsWith('/getMe')) return json({ ok: true, result: { id: 778, username: 'acme_personal_bot', first_name: 'Acme Assistant' } });
    if (url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook')) return json({ ok: true, result: true });
    if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 5000 + (++seq) } });
    if (url.endsWith('/getFile')) {
      if (body.file_id === 'PHOTO_BIG') return json({ ok: true, result: { file_id: 'PHOTO_BIG', file_size: PHOTO_BYTES.length, file_path: 'photos/file_1.jpg' } });
      if (body.file_id === 'DOC_UNSIZED') return json({ ok: true, result: { file_id: 'DOC_UNSIZED', file_path: 'documents/claims-big.pdf' } });
      if (body.file_id === 'DOC_STREAM') return json({ ok: true, result: { file_id: 'DOC_STREAM', file_path: 'documents/streams-big.pdf' } });
      if (body.file_id === 'DOC_HUGE_INFO') return json({ ok: true, result: { file_id: 'DOC_HUGE_INFO', file_size: 30 * 1024 * 1024, file_path: 'documents/huge.pdf' } });
      return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
    }
    if (url === `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/photos/file_1.jpg`) return bytes(PHOTO_BYTES, 'image/jpeg');
    if (url === `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/documents/claims-big.pdf`) {
      return new Response(new Uint8Array(4), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(CHAT_ATTACHMENT_MAX_BYTES + 1) } });
    }
    if (url === `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/documents/streams-big.pdf`) {
      return new Response(new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1024), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    // Discord
    const path = url.replace('https://discord.com/api/v10', '');
    if (method === 'GET' && path === '/users/@me') return json({ id: DISCORD_BOT, username: 'acme-ai', global_name: 'Acme AI', bot: true });
    if (method === 'GET' && path === '/oauth2/applications/@me') return json({ id: DISCORD_APP, name: 'Acme' });
    if (method === 'GET' && /^\/channels\/\d+$/.test(path)) return json({ id: path.split('/')[2], name: 'reports', type: 0 });
    if (method === 'POST' && /^\/channels\/\d+\/webhooks$/.test(path)) return json({ message: 'Missing Permissions', code: 50013 }, 403);
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) return json({ id: `77700000000000${++seq}` });
    if (method === 'POST' && path === '/users/@me/channels') return json({ id: `DM${body.recipient_id}`, type: 1 });
    if (method === 'POST' && path === '/attachments/refresh-urls') return json({ refreshed_urls: [{ original: body.attachment_urls?.[0], refreshed: DISCORD_NEW_URL }] });
    if (url === DISCORD_OLD_URL) return new Response('expired', { status: 404 });
    if (url === DISCORD_NEW_URL) return bytes(VOICE_BYTES, 'audio/ogg');
    return json({ ok: false, error: 'unknown_method' }, 404);
  };
}

// ── Pure ─────────────────────────────────────────────────────────────────

async function pureChecks() {
  const message = (parsed: ParsedInbound) => (parsed.kind === 'message' ? parsed : null);
  const tg = (fields: Record<string, unknown>) => telegramAdapter.parse(JSON.stringify({ update_id: 1, message: { message_id: 9, from: { id: 5550001 }, chat: { id: 5550001, type: 'private' }, ...fields } }), new Headers());
  const photo = message(tg({ caption: 'the receipt', photo: [
    { file_id: 'PHOTO_SMALL', file_size: 900, width: 90, height: 90 },
    { file_id: 'PHOTO_BIG', file_size: 52000, width: 1280, height: 960 },
    { file_id: 'PHOTO_MID', file_size: 9000, width: 320, height: 240 },
  ] }));
  check('telegram: a photo keeps its largest size, the caption is the text', photo?.text === 'the receipt' && photo.attachments?.length === 1
    && photo.attachments[0].kind === 'photo' && photo.attachments[0].ref === 'PHOTO_BIG' && photo.attachments[0].size === 52000, photo);
  const voice = message(tg({ voice: { file_id: 'VOICE1', duration: 7, mime_type: 'audio/ogg', file_size: 4000 } }));
  check('telegram: a voice note alone is a message with no text', voice?.text === '' && voice.attachments?.[0].kind === 'voice'
    && voice.attachments[0].duration_seconds === 7 && voice.attachments[0].mime_type === 'audio/ogg', voice);
  const document = message(tg({ document: { file_id: 'DOC1', file_name: 'Q3 numbers.pdf', mime_type: 'application/pdf', file_size: 12345 } }));
  check('telegram: a document keeps its name, type and size', document?.attachments?.[0].kind === 'document' && document.attachments[0].name === 'Q3 numbers.pdf'
    && document.attachments[0].mime_type === 'application/pdf' && document.attachments[0].size === 12345, document);
  const empty = tg({ sticker: { file_id: 'S1' } });
  check('telegram: nothing to read is still empty', empty.kind === 'ignore' && empty.reason === 'empty', empty);
  const quoted = message(tg({ text: 'yes', reply_to_message: { message_id: 4242, from: { id: 1, is_bot: true } } }));
  check('telegram: a quote names the message it answers', quoted?.replyToMessageId === '4242', quoted);

  const slackEvent = (event: Record<string, unknown>) => slackAdapter.parse(JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'EvP1', event: { type: 'message', channel_type: 'im', user: 'U_ANA', channel: 'D1', ts: '1.1', ...event } }), new Headers());
  const shared = message(slackEvent({ subtype: 'file_share', text: '', files: [
    { id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 7, url_private_download: SLACK_FILE },
    { id: 'F9', name: 'elsewhere.png', mimetype: 'image/png', url_private_download: 'https://evil.example.com/x.png' },
    { id: 'F3', name: 'clip.webm', mimetype: 'audio/webm', subtype: 'slack_audio', duration_ms: 5400, url_private_download: SLACK_REDIRECT_FILE },
  ] }));
  check('slack: shared files are attachments; one off files.slack.com is left out; a clip is a voice note', shared?.text === '' && shared.attachments?.length === 2
    && shared.attachments[0].ref === SLACK_FILE && shared.attachments[0].kind === 'photo' && shared.attachments[1].kind === 'voice' && shared.attachments[1].duration_seconds === 5, shared);
  const edited = slackEvent({ subtype: 'message_changed', text: 'x' });
  check('slack: an edit is still not a message', edited.kind === 'ignore', edited);

  const discordMessage = (d: Record<string, unknown>) => discordAdapter.parse(JSON.stringify({ v: 1, t: 'MESSAGE_CREATE', d: { id: '1', channel_id: '2', type: 0, author: { id: ANA_DISCORD, username: 'ana' }, content: '', mentions: [], ...d }, channel: { id: '2', type: 1 } }), new Headers());
  const voiceNote = message(discordMessage({ flags: 8192, attachments: [
    { id: 'A1', filename: 'voice-message.ogg', content_type: 'audio/ogg', size: 8, duration_secs: 3.2, url: DISCORD_OLD_URL },
    { id: 'A2', filename: 'x.png', content_type: 'image/png', size: 1, url: 'https://evil.example.com/x.png' },
  ] }));
  check('discord: a voice message with no words is a message; an attachment off the CDN is left out', voiceNote?.text === '' && voiceNote.attachments?.length === 1
    && voiceNote.attachments[0].kind === 'voice' && voiceNote.attachments[0].duration_seconds === 3, voiceNote);

  const agent = (id: string, name: string, isDefault = false): CompanyAgent => ({ id, name, is_default: isDefault, row: { id, name } });
  const agents = [agent('ops', 'Ops AI', true), agent('fin', 'Finance Bot')];
  const base = { direct: true, botMentioned: true, text: 'thanks', agents, channel: null };
  check('route: an answer to a started message goes to its agent, not the default', JSON.stringify(routeCompany({ ...base, answering: 'fin' })) === JSON.stringify({ kind: 'request', agent: agents[1], route: 'reply' }));
  check('route: naming another agent still wins', (routeCompany({ ...base, text: '@Ops AI hi', answering: 'fin' }) as Loose).agent?.id === 'ops');
  check('route: a starter the connection no longer reaches falls back', (routeCompany({ ...base, answering: 'gone' }) as Loose).route === 'direct');

  // The link, the provider's way.
  installProviders();
  providerCalls.length = 0;
  const link = { url: 'https://pm.example.com/reports/cash', label: 'Open <the> report' };
  await slackAdapter.send({ bot_token: COMPANY_TOKEN }, { conversationId: 'C1', threadId: null, text: 'Cash at close.', link });
  await telegramAdapter.send({ bot_token: TELEGRAM_TOKEN }, { conversationId: '5550001', threadId: null, text: 'Cash at close.', link });
  await discordAdapter.send({ bot_token: DISCORD_TOKEN }, { conversationId: DISCORD_CHANNEL, threadId: null, text: 'Cash at close.', link: { ...link, label: 'Open [the] report' } });
  const [slackPost, telegramPost, discordPost] = providerCalls;
  check('link: Slack <url|label>, the label escaped', slackPost?.body?.text === 'Cash at close.\n<https://pm.example.com/reports/cash|Open &lt;the&gt; report>', slackPost?.body);
  check('link: Telegram url button under the message', telegramPost?.body?.text === 'Cash at close.'
    && JSON.stringify(telegramPost.body.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: link.label, url: link.url }]] }), telegramPost?.body);
  check('link: Discord masked link, no embed', discordPost?.body?.content === 'Cash at close.\n[Open the report](<https://pm.example.com/reports/cash>)', discordPost?.body);

  // An agent cannot ping a whole Slack channel or group; a person it names still hears it.
  providerCalls.length = 0;
  await slackAdapter.send({ bot_token: COMPANY_TOKEN }, {
    conversationId: 'C1', threadId: null, link,
    text: '<!channel> <!here> <!everyone|everyone> <!group> <!subteam^S0123ABC|@oncall> <!subteam^S0456DEF> <!date^1700000000^{date}|Nov 14> heads up, <@U0ANA001> owns it',
  });
  const quiet = providerCalls[0]?.body;
  check('mentions: Slack broadcasts go as plain text, a person\'s mention stays', quiet?.text === '@channel @here @everyone @group @oncall @group <!date^1700000000^{date}|Nov 14> heads up, <@U0ANA001> owns it\n<https://pm.example.com/reports/cash|Open &lt;the&gt; report>'
    && quiet.link_names === false && !/<!(?!date\^)/.test(quiet.text), quiet);
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the section mirrors the migration', at > 0 && banner > 0 && SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.trim()));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  await old.exec('RESET ROLE');
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();
  const connection = (await old.query<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('slack', 'S', 'pm1:x') RETURNING id")).rows[0].id;
  const inboundStarted = await old.query("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, initiated) VALUES ($1, 'inbound', 'pending', 'D1', 'x', true)", [connection])
    .then(() => null, (e: Error) => e.message);
  check('database: only an outbound message is started', /chat_messages_initiated_check/.test(inboundStarted ?? ''), inboundStarted);
  const notArray = await old.query("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, attachments) VALUES ($1, 'inbound', 'pending', 'D1', 'x', '{}'::jsonb)", [connection])
    .then(() => null, (e: Error) => e.message);
  check('database: attachments are a list', /chat_messages_attachments_check/.test(notArray ?? ''), notArray);
  const reply = await old.query("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, route) VALUES ($1, 'inbound', 'pending', 'D1', 'x', 'reply')", [connection])
    .then(() => null, (e: Error) => e.message);
  check('database: route reply is allowed', reply === null, reply);
  const module = (await old.query<{ module_id: string }>("SELECT module_id FROM pm.permission_modules WHERE permission_key = 'chat.notify'")).rows[0];
  check('database: chat.notify belongs to the AI agents module, and no role holds it', module?.module_id === 'agents'
    && (await old.query("SELECT 1 FROM pm.role_permissions WHERE permission_key = 'chat.notify'")).rows.length === 0, module);
  const grants = (await old.query<Loose>(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = 'apply_chat_attachment_retention'`)).rows;
  check('grants: the file retention is the server\'s only', grants.length === 1 && !grants[0].anon && !grants[0].auth && grants[0].svc, grants);

  // Retention forgets file references with the text's rules, files with no text included.
  await old.query("UPDATE pm.business_settings SET chat_retention_days = 30");
  if ((await old.query('SELECT 1 FROM pm.business_settings')).rows.length === 0) await old.query("INSERT INTO pm.business_settings (business_name, chat_retention_days) VALUES ('Acme', 30)");
  const files = '[{"kind":"photo","ref":"F","name":null,"mime_type":null,"size":null,"duration_seconds":null}]';
  const rows = (await old.query<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, attachments, created_at) VALUES
    ($1, 'inbound', 'handled', 'D1', '', $2::jsonb, now() - interval '40 days'),
    ($1, 'inbound', 'pending', 'D1', '', $2::jsonb, now() - interval '40 days'),
    ($1, 'inbound', 'handled', 'D1', '', $2::jsonb, now() - interval '2 days') RETURNING id`, [connection, files])).rows.map((r) => r.id);
  const forgot = (await old.query<{ n: number }>('SELECT pm.apply_chat_attachment_retention() AS n')).rows[0].n;
  const after = (await old.query<Loose>('SELECT id, attachments FROM pm.chat_messages WHERE id = ANY($1::uuid[])', [rows])).rows;
  const of = (id: string) => after.find((r) => r.id === id)?.attachments;
  check('retention: an old file is forgotten even with no text; one still waiting, or recent, is kept', forgot === 1 && of(rows[0]) === null && of(rows[1]) !== null && of(rows[2]) !== null, { forgot, after });
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const CHAT_SCOPES = ['notifications.manage_own', 'projects.read', 'agents.act_for'];
const TEMPLATE_SCOPES = ['tasks.read', 'projects.read', 'notifications.manage_own'];

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
  const ben = await member('Ben Ode', 'member');
  const nova = await member('Nova', 'agent', { delegateOf: ana, avatar: NOVA_AVATAR });
  const ops = await member('Ops AI', 'agent');
  const finance = await member('Finance Bot', 'agent', { avatar: FINANCE_AVATAR });
  const jeff = await member('Jeff', 'agent');
  for (const m of [ops, finance]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow') ON CONFLICT DO NOTHING", [m]);
  }
  // Only the Finance Bot may message people unasked.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'chat.notify', 'api', 'allow') ON CONFLICT DO NOTHING", [finance]);
  const key = async (memberId: string, scopes: string[]) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes]);
    return secretKey;
  };
  const keys = {
    nova: await key(nova, TEMPLATE_SCOPES),
    ops: await key(ops, CHAT_SCOPES),
    opsNotify: await key(ops, [...CHAT_SCOPES, 'chat.notify']),
    finance: await key(finance, CHAT_SCOPES),
    financeNotify: await key(finance, [...CHAT_SCOPES, 'chat.notify']),
  };
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES
    ($1, 'slack', 'U_ANA', 'T1', now(), 'admin'), ($2, 'slack', 'U_BEN', 'T1', now(), 'admin')`, [ana, ben]);
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES
    ($1, 'telegram', '5550001', now(), 'link'), ($1, 'discord', $2, now(), 'link')`, [ana, ANA_DISCORD]);
  return { q, owner, ana, ben, nova, ops, finance, jeff, keys };
}

async function main() {
  await pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  installSession(server.url);
  installProviders();
  const realTransport = { ...webhookTransport };
  webhookTransport.post = async () => ({ status: 200, text: 'ok' });

  try {
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const agentsRoute = await import('../src/app/api/workspace/chat-connections/[id]/agents/route');
    const channelsRoute = await import('../src/app/api/workspace/chat-connections/[id]/channels/route');
    const inboundRoute = await import('../src/app/api/chat/inbound/[id]/route');
    const v1Messages = await import('../src/app/api/v1/chat/messages/route');
    const v1Message = await import('../src/app/api/v1/chat/messages/[id]/route');
    const v1Attachment = await import('../src/app/api/v1/chat/messages/[id]/attachments/[n]/route');
    const v1Delegations = await import('../src/app/api/v1/delegations/route');
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
    const request = (method: string, path: string, apiKey: string, body?: unknown, actFor?: string) => new NextRequest(`http://localhost${path}`, {
      method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor ? { 'x-act-for': actFor } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const send = async (apiKey: string, body: unknown, actFor?: string) =>
      read(await v1Messages.POST(request('POST', '/api/v1/chat/messages', apiKey, body, actFor), { params: Promise.resolve({}) } as never));
    const getMessage = async (apiKey: string, id: string) =>
      read(await v1Message.GET(request('GET', `/api/v1/chat/messages/${id}`, apiKey), { params: Promise.resolve({ id }) } as never));
    const attachment = (apiKey: string, id: string, n: string) =>
      v1Attachment.GET(request('GET', `/api/v1/chat/messages/${id}/attachments/${n}`, apiKey), { params: Promise.resolve({ id, n }) } as never);
    const mint = async (apiKey: string, externalId: string) =>
      (await read(await v1Delegations.POST(request('POST', '/api/v1/delegations', apiKey, { provider: 'slack', external_id: externalId, workspace_id: 'T1' }), { params: Promise.resolve({}) } as never))).body?.data?.token as string;
    const inbound = async (connectionId: string, body: unknown, headers: (raw: string) => Record<string, string>) => {
      const raw = JSON.stringify(body);
      return read(await inboundRoute.POST(new Request(`https://pm.example.com/api/chat/inbound/${connectionId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers(raw) }, body: raw,
      }), { params: Promise.resolve({ id: connectionId }) }));
    };
    const slackSigned = (secret: string) => (raw: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, raw) };
    };
    let event = 0;
    const slackEvent = (user: string, text: string, channel: string, channelType: 'im' | 'channel', extra: Record<string, unknown> = {}) => {
      event++;
      return { type: 'event_callback', team_id: 'T1', event_id: `EvO${event}`, event: { type: 'message', channel_type: channelType, user, text, channel, ts: `17100000${event}.000100`, ...extra } };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const row = async (id: string) => (await s.q<Loose>('SELECT * FROM pm.chat_messages WHERE id = $1', [id]))[0];
    const posts = () => providerCalls.filter((call) => call.url.endsWith('/chat.postMessage'));
    const leaks = (value: string) => [PERSONAL_TOKEN, COMPANY_TOKEN, TELEGRAM_TOKEN, DISCORD_TOKEN, 'api.telegram.org', 'files.slack.com', 'cdn.discordapp.com', 'PHOTO_BIG']
      .filter((secret) => value.includes(secret));
    const headerText = (headers: Headers) => [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');

    // ── Connections ────────────────────────────────────────────────────
    const personalSlack = (await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', bot_token: PERSONAL_TOKEN, signing_secret: PERSONAL_SECRET })).body?.data?.id as string;
    const companySlack = (await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'slack', kind: 'company', bot_token: COMPANY_TOKEN, signing_secret: COMPANY_SECRET })).body?.data?.id as string;
    providerCalls.length = 0;
    const personalTelegram = (await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'telegram', bot_token: TELEGRAM_TOKEN })).body?.data?.id as string;
    const telegramSecret = providerCalls.find((call) => call.url.endsWith('/setWebhook'))?.body?.secret_token as string;
    const companyDiscord = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, { provider: 'discord', kind: 'company', bot_token: DISCORD_TOKEN });
    const discordId = companyDiscord.body?.data?.id as string;
    const discordSecret = companyDiscord.body?.data?.relay_secret as string;
    await session(agentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${companySlack}/agents`, { id: companySlack }, { agent_ids: [s.ops, s.finance], default_agent_id: s.ops });
    await session(agentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${discordId}/agents`, { id: discordId }, { agent_ids: [s.ops], default_agent_id: s.ops });
    await session(channelsRoute.POST, 'POST', `/api/workspace/chat-connections/${companySlack}/channels`, { id: companySlack }, { channel: 'CFIN0001', agent_id: s.finance });
    await session(channelsRoute.POST, 'POST', `/api/workspace/chat-connections/${companySlack}/channels`, { id: companySlack }, { channel: 'COPS0001', agent_id: s.ops });
    await session(channelsRoute.POST, 'POST', `/api/workspace/chat-connections/${discordId}/channels`, { id: discordId }, { channel: DISCORD_CHANNEL, agent_id: s.ops });
    check('setup: four connections, agents and channels', !!personalSlack && !!companySlack && !!personalTelegram && !!telegramSecret && !!discordId && !!discordSecret,
      { personalSlack, companySlack, personalTelegram, discordId });

    // ── A personal assistant writes first ──────────────────────────────
    const hello = slackEvent('U_ANA', 'hi Nova', 'D_ANA_P', 'im');
    await inbound(personalSlack, hello, slackSigned(PERSONAL_SECRET));
    const ambiguous = await send(s.keys.nova, { text: 'Morning digest: 3 tasks due.' });
    check('personal: two personal connections where Ana linked an account asks which', ambiguous.status === 409 && reason(ambiguous) === 'choose_connection'
      && ambiguous.body.error.details.options.length === 2, ambiguous.body);
    providerCalls.length = 0;
    const digest = await send(s.keys.nova, { text: 'Morning digest: 3 tasks due.', provider: 'slack', link: { url: 'https://pm.example.com/tasks', label: 'Open My Tasks' } });
    const digestPost = posts()[0];
    const digestRow = digest.body?.data?.id ? await row(digest.body.data.id) : null;
    check('personal: Nova DMs Ana in the DM she wrote from, under its own name and avatar, with the link', digest.status === 201 && digest.body.data.direct === true
      && digest.body.data.to.person_id === s.ana && digestPost?.body?.channel === 'D_ANA_P' && digestPost.body.username === 'Nova' && digestPost.body.icon_url === NOVA_AVATAR
      && digestPost.auth === `Bearer ${PERSONAL_TOKEN}` && digestPost.body.text === 'Morning digest: 3 tasks due.\n<https://pm.example.com/tasks|Open My Tasks>', { digest: digest.body, digestPost });
    check('personal: recorded as a started message for Ana', digestRow?.initiated === true && digestRow.direction === 'outbound' && digestRow.agent_id === s.nova
      && digestRow.member_id === s.ana && digestRow.is_direct === true && digestRow.external_message_id === digest.body?.data?.external_message_id && !!digestRow.external_message_id && digestRow.status === 'sent', digestRow);
    const toBen = await send(s.keys.nova, { text: 'hi', provider: 'slack', person_id: s.ben });
    const toChannel = await send(s.keys.nova, { text: 'hi', provider: 'slack', channel: 'CFIN0001' });
    check('personal: anyone else, or any channel, is refused', toBen.status === 403 && reason(toBen) === 'recipient_not_allowed'
      && toChannel.status === 403 && reason(toChannel) === 'recipient_not_allowed', [toBen.body, toChannel.body]);
    providerCalls.length = 0;
    const onTelegram = await send(s.keys.nova, { text: 'Urgent: the bank emailed.', provider: 'telegram', link: { url: 'https://pm.example.com/inbox', label: 'Open the email' } });
    const tgSent = providerCalls.find((call) => call.url.endsWith('/sendMessage'));
    check('personal: on Telegram, to Ana\'s own chat, the link as a button', onTelegram.status === 201 && tgSent?.body?.chat_id === '5550001'
      && tgSent.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url === 'https://pm.example.com/inbox', { onTelegram: onTelegram.body, tgSent });

    const thanks = slackEvent('U_ANA', 'thanks, move the first one', 'D_ANA_P', 'im');
    const thanksIn = await inbound(personalSlack, thanks, slackSigned(PERSONAL_SECRET));
    const thanksRead = await getMessage(s.keys.nova, thanksIn.body?.id);
    check('personal: Ana\'s reply goes to Nova and names the digest it answers', ['pending', 'notified'].includes(thanksIn.body?.status) && thanksRead.body?.data?.in_reply_to === digest.body?.data?.id
      && thanksRead.body.data.agent_id === s.nova, { thanksIn: thanksIn.body, read: thanksRead.body?.data });

    // ── A company agent writes first ───────────────────────────────────
    providerCalls.length = 0;
    const report = await send(s.keys.finance, { text: 'Cash at close: 41,200.', channel: '#finance', link: { url: 'https://pm.example.com/reports/cash', label: 'Open report' } });
    const reportPost = posts()[0];
    check('company: Finance Bot posts in its mapped channel, under its own name, with the link', report.status === 201 && report.body.data.to.channel_id === 'CFIN0001'
      && report.body.data.to.channel_name === '#finance' && reportPost?.body?.channel === 'CFIN0001' && reportPost.body.username === 'Finance Bot'
      && !('thread_ts' in reportPost.body) && reportPost.body.text.endsWith('\n<https://pm.example.com/reports/cash|Open report>') && reportPost.auth === `Bearer ${COMPANY_TOKEN}`, { report: report.body, reportPost });
    const unmapped = await send(s.keys.finance, { text: 'hi', channel: 'COPS0001' });
    const defaultUnmapped = await send(s.keys.ops, { text: 'hi', channel: 'C_GEN' });
    check('company: a channel mapped to another agent, or none, is refused (the default too)', unmapped.status === 403 && reason(unmapped) === 'channel_not_allowed'
      && defaultUnmapped.status === 403 && reason(defaultUnmapped) === 'channel_not_allowed', [unmapped.body, defaultUnmapped.body]);
    const noRecipient = await send(s.keys.finance, { text: 'hi' });
    check('company: a recipient is required', noRecipient.status === 422, noRecipient.body);

    // A reply in the report's thread, with no mention, goes back to Finance Bot.
    const threadReply = slackEvent('U_BEN', 'why so low?', 'CFIN0001', 'channel', { thread_ts: report.body?.data?.external_message_id });
    const threadIn = await inbound(companySlack, threadReply, slackSigned(COMPANY_SECRET));
    const threadRow = threadIn.body?.id ? await row(threadIn.body.id) : null;
    check('company: a reply in the started message\'s thread is a request to its agent, route reply', ['pending', 'notified'].includes(threadIn.body?.status) && threadRow?.agent_id === s.finance
      && threadRow.route === 'reply' && threadRow.reply_to_id === report.body?.data?.id && threadRow.member_id === s.ben && threadRow.is_request === true, { threadIn: threadIn.body, threadRow });
    const chatter = slackEvent('U_BEN', 'lunch?', 'CFIN0001', 'channel');
    const chatterIn = await inbound(companySlack, chatter, slackSigned(COMPANY_SECRET));
    check('company: chatter outside that thread is still ignored', chatterIn.body?.status === 'ignored', chatterIn.body);

    // DMs.
    const unasked = await send(s.keys.finance, { text: 'Your expense report bounced.', person_id: s.ben });
    check('company: a DM without X-Act-For or chat.notify is refused', unasked.status === 403 && reason(unasked) === 'chat_notify_required', unasked.body);
    const opsScopeOnly = await send(s.keys.opsNotify, { text: 'hi', person_id: s.ben });
    check('company: chat.notify on the key alone (not the agent) is refused', opsScopeOnly.status === 403 && reason(opsScopeOnly) === 'chat_notify_required', opsScopeOnly.body);
    const benPass = await mint(s.keys.finance, 'U_BEN');
    const anaPass = await mint(s.keys.finance, 'U_ANA');
    const mismatch = await send(s.keys.finance, { text: 'hi', person_id: s.ben }, anaPass);
    check('company: a pass for someone else is refused', !!anaPass && mismatch.status === 403 && reason(mismatch) === 'act_for_mismatch', mismatch.body);
    providerCalls.length = 0;
    const forBen = await send(s.keys.finance, { text: 'Your refund went out.', person_id: s.ben }, benPass);
    const opened = providerCalls.find((call) => call.url.endsWith('/conversations.open'));
    check('company: acting for Ben, Finance Bot DMs Ben', !!benPass && forBen.status === 201 && opened?.body?.users === 'U_BEN' && posts()[0]?.body?.channel === 'D_PRIVATE_U_BEN'
      && posts()[0]?.body?.username === 'Finance Bot', { forBen: forBen.body, calls: providerCalls.map((c) => c.url) });
    const notify = await send(s.keys.financeNotify, { text: 'Payroll runs tomorrow.', person_id: s.ben });
    check('company: with chat.notify on the agent and the key, an unprompted DM goes', notify.status === 201 && notify.body.data.to.person_id === s.ben, notify.body);
    const stranger = await send(s.keys.financeNotify, { text: 'hi', person_id: s.owner });
    check('company: a member with no linked account there is refused', stranger.status === 409 && reason(stranger) === 'no_linked_chat', stranger.body);

    // Ben answers in the DM: Finance Bot, not the default, until he names another.
    const benDm = (text: string) => slackEvent('U_BEN', text, 'D_PRIVATE_U_BEN', 'im');
    const benReply = await inbound(companySlack, benDm('which account?'), slackSigned(COMPANY_SECRET));
    const benReplyRow = await row(benReply.body?.id);
    const benAgain = await inbound(companySlack, benDm('and when?'), slackSigned(COMPANY_SECRET));
    const benAgainRow = await row(benAgain.body?.id);
    check('company: a DM reply after a started message goes back to its agent, and stays with it', benReplyRow?.agent_id === s.finance && benReplyRow.route === 'reply'
      && benReplyRow.reply_to_id === notify.body?.data?.id && benAgainRow?.agent_id === s.finance && benAgainRow.route === 'reply', [benReplyRow, benAgainRow]);
    const benNames = await inbound(companySlack, benDm('@Ops AI is staging up?'), slackSigned(COMPANY_SECRET));
    const benAfter = await inbound(companySlack, benDm('thanks'), slackSigned(COMPANY_SECRET));
    check('company: naming another agent ends it; the DM goes back to the default', (await row(benNames.body?.id))?.agent_id === s.ops
      && (await row(benAfter.body?.id))?.agent_id === s.ops && (await row(benAfter.body?.id))?.route === 'direct');
    const benReplyRead = await getMessage(s.keys.finance, benReply.body?.id);
    check('company: the reply reads with in_reply_to', benReplyRead.body?.data?.in_reply_to === notify.body?.data?.id && benReplyRead.body.data.route === 'reply', benReplyRead.body?.data);

    // Discord: a mapped channel, the link as a masked link.
    providerCalls.length = 0;
    const discordPost = await send(s.keys.ops, { text: 'Deploy done.', channel: DISCORD_CHANNEL, link: { url: 'https://pm.example.com/deploys', label: 'Deploys' } });
    const discordCall = providerCalls.find((call) => call.url.endsWith(`/channels/${DISCORD_CHANNEL}/messages`));
    check('discord: Ops AI posts in its mapped channel, its name in bold, the link masked', discordPost.status === 201
      && discordCall?.body?.content === '**Ops AI**\nDeploy done.\n[Deploys](<https://pm.example.com/deploys>)', { discordPost: discordPost.body, discordCall });

    // ── Limits and pause ───────────────────────────────────────────────
    const fill = (connectionId: string, subject: string, count: number) => s.q(`INSERT INTO pm.chat_rate_limits (connection_id, subject, window_start, request_count) VALUES ($1, $2, now(), $3)
      ON CONFLICT (connection_id, subject) DO UPDATE SET window_start = now(), request_count = $3`, [connectionId, subject, count]);
    await fill(personalSlack, `out:to:member:${s.ana}`, 20);
    providerCalls.length = 0;
    const perPerson = await send(s.keys.nova, { text: 'one more', provider: 'slack' });
    check('limits: 20 an hour per recipient, then 429, nothing sent', perPerson.status === 429 && reason(perPerson) === 'chat_rate_limited'
      && perPerson.body.error.details.limit === 'recipient' && posts().length === 0, perPerson.body);
    await s.q('DELETE FROM pm.chat_rate_limits WHERE connection_id = $1', [personalSlack]);
    await fill(personalSlack, `out:agent:${s.nova}`, 60);
    const perAgent = await send(s.keys.nova, { text: 'one more', provider: 'slack' });
    check('limits: 60 an hour per agent, then 429', perAgent.status === 429 && perAgent.body.error.details.limit === 'agent', perAgent.body);
    await s.q('DELETE FROM pm.chat_rate_limits WHERE connection_id = $1', [personalSlack]);
    const backOn = await send(s.keys.nova, { text: 'one more', provider: 'slack' });
    check('limits: a fresh window sends again', backOn.status === 201, backOn.body);

    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [s.finance]);
    providerCalls.length = 0;
    const paused = await send(s.keys.financeNotify, { text: 'hi', channel: '#finance' });
    check('pause: a paused agent cannot start a message, 423', paused.status === 423 && reason(paused) === 'agent_paused' && posts().length === 0, paused.body);
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [s.finance]);

    // ── Files: Telegram ────────────────────────────────────────────────
    const tg = async (updateId: number, fields: Record<string, unknown>) => inbound(personalTelegram, {
      update_id: updateId, message: { message_id: updateId, from: { id: 5550001, username: 'ana' }, chat: { id: 5550001, type: 'private' }, ...fields },
    }, () => ({ 'x-telegram-bot-api-secret-token': telegramSecret }));
    const photoIn = await tg(501, { caption: 'the receipt', photo: [{ file_id: 'PHOTO_SMALL', file_size: 90, width: 90, height: 90 }, { file_id: 'PHOTO_BIG', file_size: PHOTO_BYTES.length + 100000, width: 1280, height: 960 }] });
    const photoRow = await row(photoIn.body?.id);
    check('telegram: a photo with a caption is recorded with the caption as text and the largest size', ['pending', 'notified'].includes(photoIn.body?.status) && photoRow?.text === 'the receipt'
      && photoRow.attachments?.[0]?.ref === 'PHOTO_BIG' && photoRow.attachments[0].kind === 'photo' && photoRow.agent_id === s.nova, photoRow);
    const voiceIn = await tg(502, { voice: { file_id: 'VOICE1', duration: 7, mime_type: 'audio/ogg', file_size: 4000 } });
    const voiceRow = await row(voiceIn.body?.id);
    check('telegram: a voice note alone is a request for the assistant', ['pending', 'notified'].includes(voiceIn.body?.status) && voiceRow?.text === '' && voiceRow.is_request === true
      && voiceRow.attachments?.[0]?.kind === 'voice', { voiceIn: voiceIn.body, voiceRow });
    const photoEvent = (await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'chat.message' AND resource_id = $1", [photoIn.body?.id]))[0]?.payload;
    const photoRead = await getMessage(s.keys.nova, photoIn.body?.id);
    const view = photoRead.body?.data?.attachments?.[0];
    check('telegram: the message lists the file with its download path, never its file id', photoRead.status === 200 && view?.kind === 'photo' && view.index === 0
      && view.download?.path === `/api/v1/chat/messages/${photoIn.body?.id}/attachments/0` && view.mime_type === 'image/jpeg' && !('ref' in view)
      && leaks(photoRead.text).length === 0, { data: photoRead.body?.data?.attachments, leaks: leaks(photoRead.text) });
    // No webhook endpoint here, so build the payload the way delivery does.
    const { chatMessagePayload } = await import('../src/lib/chat/messages');
    const payload = photoEvent ?? await chatMessagePayload(service, photoIn.body?.id);
    const data = payload.data ?? payload;
    check('telegram: chat.message says has_attachments and attachment_count, ids only', data.has_attachments === true && data.attachment_count === 1
      && !JSON.stringify(payload).includes('PHOTO_BIG') && !JSON.stringify(payload).includes('receipt'), payload);

    providerCalls.length = 0;
    const fetched = await attachment(s.keys.nova, photoIn.body?.id, '0');
    const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
    const fileCall = providerCalls.find((call) => call.url.includes('/file/bot'));
    check('fetch: the bytes come through the app from Telegram (getFile, then the file)', fetched.status === 200 && fetchedBytes.equals(PHOTO_BYTES)
      && providerCalls.some((call) => call.url.endsWith('/getFile') && call.body.file_id === 'PHOTO_BIG') && !!fileCall, { status: fetched.status, calls: providerCalls.map((c) => c.url.replace(TELEGRAM_TOKEN, 'TOKEN')) });
    check('fetch: no token or provider address in the answer, a download with its type, never cached', leaks(headerText(fetched.headers)).length === 0
      && fetched.headers.get('content-type') === 'image/jpeg' && fetched.headers.get('cache-control') === 'no-store' && /^attachment;/.test(fetched.headers.get('content-disposition') ?? '')
      && fetched.headers.get('location') === null, headerText(fetched.headers));
    const opsTry = await read(await attachment(s.keys.ops, photoIn.body?.id, '0'));
    check('fetch: only the agent the message was routed to; anyone else reads it as missing', opsTry.status === 404, opsTry.body);
    const noSuch = await read(await attachment(s.keys.nova, photoIn.body?.id, '3'));
    check('fetch: no such file is 404', noSuch.status === 404, noSuch.body);

    // The 20 MB cap.
    const bigStored = await tg(503, { document: { file_id: 'DOC_HUGE', file_name: 'scan.pdf', mime_type: 'application/pdf', file_size: 25 * 1024 * 1024 } });
    providerCalls.length = 0;
    const tooBig = await read(await attachment(s.keys.nova, bigStored.body?.id, '0'));
    check('cap: a file known to be over 20 MB is 413 without asking Telegram', tooBig.status === 413 && reason(tooBig) === 'attachment_too_large' && providerCalls.length === 0, tooBig.body);
    const bigInfo = await tg(504, { document: { file_id: 'DOC_HUGE_INFO', file_name: 'scan2.pdf' } });
    const tooBigInfo = await read(await attachment(s.keys.nova, bigInfo.body?.id, '0'));
    check('cap: Telegram saying it is over 20 MB is 413', tooBigInfo.status === 413, tooBigInfo.body);
    const bigLength = await tg(505, { document: { file_id: 'DOC_UNSIZED', file_name: 'claims.pdf' } });
    const tooBigLength = await read(await attachment(s.keys.nova, bigLength.body?.id, '0'));
    check('cap: a Content-Length over 20 MB is 413 before any byte is read', tooBigLength.status === 413 && leaks(tooBigLength.text).length === 0, tooBigLength.body);
    const bigStream = await tg(506, { document: { file_id: 'DOC_STREAM', file_name: 'streams.pdf' } });
    const streaming = await attachment(s.keys.nova, bigStream.body?.id, '0');
    const streamed = await streaming.arrayBuffer().then((buffer) => buffer.byteLength, (error: Error) => error);
    check('cap: a body that grows past 20 MB stops', streamed instanceof Error || (typeof streamed === 'number' && streamed <= CHAT_ATTACHMENT_MAX_BYTES), typeof streamed === 'number' ? streamed : String(streamed));
    const badFile = await tg(507, { document: { file_id: 'GONE', file_name: 'gone.pdf' } });
    const refused = await read(await attachment(s.keys.nova, badFile.body?.id, '0'));
    check('fetch: Telegram refusing is 502 with its reason, no token in it', refused.status === 502 && reason(refused) === 'provider_refused' && leaks(refused.text).length === 0, refused.body);

    // ── Files: Slack ───────────────────────────────────────────────────
    const shared = slackEvent('U_ANA', '', 'D_ANA_C', 'im', { subtype: 'file_share', files: [
      { id: 'F1', name: 'shot.png', mimetype: 'image/png', size: SLACK_BYTES.length, url_private_download: SLACK_FILE },
      { id: 'F2', name: 'moved.png', mimetype: 'image/png', size: 3, url_private_download: SLACK_REDIRECT_FILE },
    ] });
    const sharedIn = await inbound(companySlack, shared, slackSigned(COMPANY_SECRET));
    const sharedRow = await row(sharedIn.body?.id);
    check('slack: shared files with no words are a request to the default agent', ['pending', 'notified'].includes(sharedIn.body?.status) && sharedRow?.agent_id === s.ops
      && sharedRow.attachments?.length === 2 && sharedRow.text === '', { sharedIn: sharedIn.body, sharedRow });
    providerCalls.length = 0;
    const slackFetched = await attachment(s.keys.ops, sharedIn.body?.id, '0');
    const slackBytes = Buffer.from(await slackFetched.arrayBuffer());
    const slackCall = providerCalls.find((call) => call.url === SLACK_FILE);
    check('slack: fetched with the bot token in the header, proxied', slackFetched.status === 200 && slackBytes.equals(SLACK_BYTES) && slackCall?.auth === `Bearer ${COMPANY_TOKEN}`
      && leaks(headerText(slackFetched.headers)).length === 0, { status: slackFetched.status, auth: slackCall?.auth });
    providerCalls.length = 0;
    const redirected = await read(await attachment(s.keys.ops, sharedIn.body?.id, '1'));
    check('slack: a redirect off Slack is refused; the token never goes there', redirected.status === 502 && redirected.body?.error?.details?.code === 'redirected'
      && !providerCalls.some((call) => call.url.startsWith('https://evil.example.com')), { body: redirected.body, calls: providerCalls.map((c) => c.url) });
    const financeTry = await read(await attachment(s.keys.finance, sharedIn.body?.id, '0'));
    check('slack: another company agent cannot fetch it', financeTry.status === 404, financeTry.body);

    // ── Files: Discord ─────────────────────────────────────────────────
    const discordBody = { v: 1, t: 'MESSAGE_CREATE', d: {
      id: '990000000000000001', channel_id: '990000000000000002', type: 0, flags: 8192, author: { id: ANA_DISCORD, username: 'ana' }, content: '', mentions: [],
      attachments: [{ id: 'A1', filename: 'voice-message.ogg', content_type: 'audio/ogg', size: VOICE_BYTES.length, duration_secs: 3.2, url: DISCORD_OLD_URL }],
    }, channel: { id: '990000000000000002', type: 1 } };
    const discordIn = await inbound(discordId, discordBody, (raw) => ({ [RELAY_SIGNATURE_HEADER]: relaySignatureHeader(discordSecret, raw) }));
    const discordRow = await row(discordIn.body?.id);
    check('discord: a voice message with no words is a request to the default agent', ['notified', 'pending'].includes(discordIn.body?.status) && discordRow?.agent_id === s.ops
      && discordRow.attachments?.[0]?.kind === 'voice', { discordIn: discordIn.body, discordRow });
    providerCalls.length = 0;
    const discordFetched = await attachment(s.keys.ops, discordIn.body?.id, '0');
    const discordBytes = Buffer.from(await discordFetched.arrayBuffer());
    const refresh = providerCalls.find((call) => call.url.endsWith('/attachments/refresh-urls'));
    check('discord: an expired CDN link is refreshed with the bot token and proxied', discordFetched.status === 200 && discordBytes.equals(VOICE_BYTES)
      && refresh?.auth === `Bot ${DISCORD_TOKEN}` && refresh.body?.attachment_urls?.[0] === DISCORD_OLD_URL && leaks(headerText(discordFetched.headers)).length === 0,
    { status: discordFetched.status, calls: providerCalls.map((c) => c.url) });

    // ── MCP and logs ───────────────────────────────────────────────────
    const tools = async (memberId: string, scopes: string[]) => toolsFor({ access: (await resolveMemberAccess(service, memberId))!, scopes, readOnly: false, profile: 'generic' }).map((t) => t.name);
    check('mcp: personal and company agents see send_chat_message; an agent that cannot act for people does not',
      (await tools(s.finance, CHAT_SCOPES)).includes('send_chat_message') && (await tools(s.nova, TEMPLATE_SCOPES)).includes('send_chat_message')
      && !(await tools(s.jeff, ['notifications.manage_own', 'projects.read'])).includes('send_chat_message'));
    const audit = (await s.q<{ body: string }>('SELECT request_body::text AS body FROM pm.api_audit_log')).map((r) => r.body).join('\n');
    check('logs: no token and no message text in the audit log', leaks(audit).length === 0 && !audit.includes('Cash at close'), leaks(audit));
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
