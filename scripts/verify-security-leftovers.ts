/**
 * The security review's leftovers (2.0.50 deep review, findings 9, 11, 13),
 * each with what it must stop and what it must keep working:
 *
 * 1. Wrong keys: an address that sent 300 keys matching nothing in five
 *    minutes is answered 429 before the key lookup (no database call); a
 *    working key pays no extra database call; the address is the platform's
 *    (x-vercel-forwarded-for, x-real-ip), never x-forwarded-for.
 * 2. Rotation overlap: an agent replacing its own key keeps the old one an
 *    hour at most (and by default); an Owner rotating an agent's key keeps
 *    up to 168 hours.
 * 3. Script nonces: every page but the portal gets a fresh nonce in its
 *    request (for Next) and its answer's policy, with 'strict-dynamic'; an
 *    HTML preview's scripts get the nonce too.
 * 4. Webhook secrets: without APP_ENCRYPTION_KEY a new endpoint or a new
 *    signing secret is refused (409 encryption_key_missing), nothing is
 *    written; a plain-text secret stored before still signs.
 * 5. Discord relay: the migration and schema.sql agree; a relay that sends
 *    heartbeats and then goes quiet reads not_receiving (the inbound side is
 *    in test:discord-chat).
 * 6. The end-to-end harness retries only while the dev server compiles.
 *
 *   npm run -s test:security-leftovers
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import {
  BAD_KEY_LIMIT, BAD_KEY_MAX_ADDRESSES, BAD_KEY_WINDOW_MS, assertBadKeyBudget, badKeyAddresses, noteBadKey, resetBadKeyLimit, trustedClientIp,
} from '../src/lib/api/bad-key-limit';
import { newScriptNonce, pageContentSecurityPolicy, pagePolicyApplies, NONCE_HEADER } from '../src/lib/security/frame-headers';
import { withScriptNonce } from '../src/lib/security/preview-nonce';
import { chatConnectionHealth, relaySilent, RELAY_SILENT_MINUTES } from '../src/lib/chat/types';
import { discordAdapter } from '../src/lib/chat/providers/discord';
import { fetchWhileCompiling, isCompileAnswer, isTransportError } from './e2e/retry';

const MIGRATION = '20261127002600_chat_relay_heartbeat.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are read field by field
type Loose = any;

// ── 1. Wrong keys, pure ─────────────────────────────────────────────────
function badKeyPureChecks() {
  const h = (entries: Record<string, string>) => new Headers(entries);
  check('address: on Vercel, Vercel\'s own header first', trustedClientIp(h({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.1' }), true) === '203.0.113.7');
  check('address: off Vercel, x-vercel-forwarded-for is the caller\'s own and ignored', trustedClientIp(h({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.1' }), false) === '198.51.100.1'
    && trustedClientIp(h({ 'x-vercel-forwarded-for': '203.0.113.7' }), false) === null);
  check('address: x-real-ip without Vercel\'s', trustedClientIp(h({ 'x-real-ip': '2001:db8::1' })) === '2001:db8::1');
  check('address: never x-forwarded-for (the caller writes its first hop)', trustedClientIp(h({ 'x-forwarded-for': '203.0.113.9' })) === null);
  check('address: a header that is not an address is none', trustedClientIp(h({ 'x-vercel-forwarded-for': 'evil', 'x-real-ip': '1.2.3' }), true) === null);

  resetBadKeyLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < BAD_KEY_LIMIT * 3; i++) noteBadKey('203.0.113.7', 'pk_live_revoked_one', t0);
  let sameKey = false;
  try { assertBadKeyBudget('203.0.113.7', t0); } catch { sameKey = true; }
  check('limit: one wrong key sent again and again counts once (an agent retrying a revoked key never locks out its neighbours)', !sameKey);
  resetBadKeyLimit();
  for (let i = 0; i < BAD_KEY_LIMIT - 1; i++) noteBadKey('203.0.113.7', `pk_live_guess_${i}`, t0);
  let refused = false;
  try { assertBadKeyBudget('203.0.113.7', t0); } catch { refused = true; }
  check(`limit: ${BAD_KEY_LIMIT - 1} wrong keys still pass`, !refused);
  noteBadKey('203.0.113.7', 'pk_live_guess_last', t0);
  let error: Loose = null;
  try { assertBadKeyBudget('203.0.113.7', t0 + 1000); } catch (e) { error = e; }
  check(`limit: the ${BAD_KEY_LIMIT}th wrong key closes the address with 429 too_many_bad_keys`, error?.statusCode === 429 && error?.details?.reason === 'too_many_bad_keys'
    && Date.parse(error.details.reset_at) === t0 + BAD_KEY_WINDOW_MS, error?.details);
  let other = false;
  try { assertBadKeyBudget('198.51.100.1', t0 + 1000); } catch { other = true; }
  check('limit: another address is not affected', !other);
  let after = false;
  try { assertBadKeyBudget('203.0.113.7', t0 + BAD_KEY_WINDOW_MS); } catch { after = true; }
  check('limit: the address opens again when its window ends', !after);
  let none = false;
  for (let i = 0; i < BAD_KEY_LIMIT * 2; i++) noteBadKey(null, `pk_live_guess_${i}`, t0);
  try { assertBadKeyBudget(null, t0); } catch { none = true; }
  check('limit: without a trusted address nothing is counted (no shared bucket to lock everyone out)', !none);
  resetBadKeyLimit();
  for (let i = 0; i < BAD_KEY_MAX_ADDRESSES + 50; i++) noteBadKey(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 'pk_live_x', t0);
  check('limit: the memory is bounded', badKeyAddresses() === BAD_KEY_MAX_ADDRESSES, badKeyAddresses());
  resetBadKeyLimit();
}

// ── 3. Script nonces, pure ──────────────────────────────────────────────
function nonceChecks() {
  const a = newScriptNonce();
  const b = newScriptNonce();
  check('nonce: 128 random bits, base64, fresh each time', /^[A-Za-z0-9+/]{22}==$/.test(a) && a !== b, [a, b]);
  const page = pageContentSecurityPolicy('/dashboard', 'abc123', false);
  const directives = page.split(';').map((d) => d.trim());
  check('policy: scripts need the nonce or a script that had it (strict-dynamic)', directives.includes("script-src 'self' 'nonce-abc123' 'strict-dynamic' https: 'wasm-unsafe-eval'"), page);
  check('policy: WebAssembly may compile (the invoice PDF preview lays out pages with it)', /'wasm-unsafe-eval'/.test(page), page);
  check('policy: keeps no plugins, no <base>, framed by the app only', directives.includes("object-src 'none'") && directives.includes("base-uri 'self'") && directives.includes("frame-ancestors 'self'"), page);
  check('policy: no eval in production; eval in development only', !/'unsafe-eval'/.test(page) && /'unsafe-eval'/.test(pageContentSecurityPolicy('/dashboard', 'abc123', true)));
  check('policy: no unsafe-inline for scripts', !/unsafe-inline/.test(page));
  check('policy: sign-in and the consent screen are never framed', /frame-ancestors 'none'/.test(pageContentSecurityPolicy('/login', 'n', false))
    && /frame-ancestors 'none'/.test(pageContentSecurityPolicy('/login/reset', 'n', false)) && /frame-ancestors 'none'/.test(pageContentSecurityPolicy('/oauth/consent', 'n', false))
    && /frame-ancestors 'self'/.test(pageContentSecurityPolicy('/loginx', 'n', false)));
  check('policy: pages get it; the portal, API routes and Next\'s files do not', pagePolicyApplies('/dashboard') && pagePolicyApplies('/') && pagePolicyApplies('/email-preview')
    && !pagePolicyApplies('/portal/acme') && !pagePolicyApplies('/portal') && !pagePolicyApplies('/api/v1/tasks') && !pagePolicyApplies('/_next/data/x.json')
    && pagePolicyApplies('/portals'));
  check('preview: each script tag of an HTML file gets the page nonce, first', withScriptNonce('<p>x</p><script>go()</script><SCRIPT src="a.js" nonce="old"></SCRIPT><scripts>', 'n0nce')
    === '<p>x</p><script nonce="n0nce">go()</script><SCRIPT nonce="n0nce" src="a.js" nonce="old"></SCRIPT><scripts>');
  check('preview: without a nonce, or with one that is not base64, the file is untouched', withScriptNonce('<script>x</script>', undefined) === '<script>x</script>'
    && withScriptNonce('<script>x</script>', '"><img') === '<script>x</script>');
}

async function proxyChecks() {
  Object.assign(process.env, { NEXT_PUBLIC_DEMO_MODE: 'true', DEMO_MODE: 'true' });
  try {
    const { proxy } = await import('../src/proxy');
    const page = async (path: string) => proxy(new NextRequest(`http://localhost${path}`));
    const first = await page('/dashboard');
    const second = await page('/dashboard');
    const policy = first.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] ?? '';
    check('proxy: a page answers with a nonce policy', /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(policy), policy);
    check('proxy: Next and the layout get the same nonce in the request', first.headers.get('x-middleware-request-content-security-policy') === policy
      && first.headers.get(`x-middleware-request-${NONCE_HEADER}`) === nonce && nonce.length > 0, Object.fromEntries(first.headers));
    check('proxy: every request gets its own nonce', (second.headers.get('content-security-policy') ?? '') !== policy);
    const portal = await page('/portal/acme');
    const api = await page('/api/v1/tasks');
    check('proxy: the portal and API routes get no nonce policy', !portal.headers.get('content-security-policy') && !api.headers.get('content-security-policy')
      && !portal.headers.get(`x-middleware-request-${NONCE_HEADER}`));
    const sent = await proxy(new NextRequest('http://localhost/portal/acme', { headers: { [NONCE_HEADER]: 'callers-own' } }));
    check('proxy: a nonce the caller sends is dropped, never passed on', sent.headers.get(`x-middleware-request-${NONCE_HEADER}`) !== 'callers-own'
      && !(sent.headers.get('x-middleware-override-headers') ?? '').split(',').includes(NONCE_HEADER), Object.fromEntries(sent.headers));
  } finally {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    delete process.env.DEMO_MODE;
  }
}

// ── 5. Discord relay, pure and the migration ────────────────────────────
function relayChecks() {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const base = { enabled: true, kind: 'personal' as const, agents: [], last_refused_at: null };
  check('relay: a heartbeat is a ping that says so; the hello is a plain ping',
    JSON.stringify(discordAdapter.parse(JSON.stringify({ v: 1, t: 'RELAY_HEARTBEAT', d: { interval_seconds: 300 } }), new Headers())) === JSON.stringify({ kind: 'ping', heartbeat: true })
    && JSON.stringify(discordAdapter.parse(JSON.stringify({ v: 1, t: 'RELAY_READY' }), new Headers())) === JSON.stringify({ kind: 'ping' }));
  check('relay: beating within the window is connected', chatConnectionHealth({ ...base, last_inbound_at: ago(4), relay_seen_at: ago(4) }, now) === 'connected');
  check(`relay: quiet past ${RELAY_SILENT_MINUTES} minutes after a heartbeat is not_receiving`, chatConnectionHealth({ ...base, last_inbound_at: ago(RELAY_SILENT_MINUTES + 1), relay_seen_at: ago(RELAY_SILENT_MINUTES + 1) }, now) === 'not_receiving'
    && relaySilent({ last_inbound_at: ago(20), relay_seen_at: ago(30) }, now));
  check('relay: a message since the last heartbeat counts as alive', chatConnectionHealth({ ...base, last_inbound_at: ago(2), relay_seen_at: ago(60) }, now) === 'connected');
  check('relay: an older relay (never a heartbeat) is judged as before', chatConnectionHealth({ ...base, last_inbound_at: ago(60 * 24), relay_seen_at: null }, now) === 'connected'
    && chatConnectionHealth({ ...base, last_inbound_at: ago(60 * 24) }, now) === 'connected');
  check('relay: switched off stays Off', chatConnectionHealth({ ...base, enabled: false, last_inbound_at: ago(60), relay_seen_at: ago(60) }, now) === 'off');
  const relaySource = readFileSync(join(__dirname, '..', 'relay', 'discord', 'relay.mjs'), 'utf8');
  check('relay: the shipped relay sends RELAY_HEARTBEAT every 300 seconds', /t: 'RELAY_HEARTBEAT'/.test(relaySource) && /HEARTBEAT_SECONDS = 300/.test(relaySource));

  const banner = `-- CHAT RELAY HEARTBEAT (${MIGRATION})`;
  const at = SCHEMA_SQL.indexOf(banner);
  check('migration: schema.sql carries it under its banner', at > 0 && SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.trim()));
}

async function migrationRuns() {
  const at = SCHEMA_SQL.indexOf(`-- CHAT RELAY HEARTBEAT (${MIGRATION})`);
  const bannerStart = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const db = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, bannerStart) });
  const before = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'chat_connections' AND column_name = 'relay_seen_at'");
  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  const after = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'chat_connections' AND column_name = 'relay_seen_at'");
  check('migration: adds relay_seen_at to an upgraded database, safe to run twice', before.rows.length === 0 && after.rows.length === 1);
  await db.close();
}

// ── 6. The end-to-end retry ─────────────────────────────────────────────
async function retryChecks() {
  const html500 = '<!DOCTYPE html><html><body>Internal Server Error</body></html>';
  check('retry: a JSON 500 is the app answering, never retried', !isCompileAnswer(500, '{"error":{"code":"INTERNAL_ERROR"}}', 'GET'));
  check('retry: an HTML 500 on a read is retried, on a write only when it says it is compiling', isCompileAnswer(500, html500, 'GET') && !isCompileAnswer(500, html500, 'POST')
    && isCompileAnswer(500, '<html>Module not found: Can\'t resolve x</html>', 'POST'));
  check('retry: 502 and 503 that are not the app\'s JSON are retried; 404 and 4xx never', isCompileAnswer(502, '', 'POST') && isCompileAnswer(503, 'Service Unavailable', 'GET')
    && !isCompileAnswer(503, '{"error":"busy"}', 'GET') && !isCompileAnswer(404, '<html>', 'GET') && !isCompileAnswer(401, '', 'GET'));
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  check('retry: a dropped or refused connection is a compile sign; a timeout or another error is not', isTransportError(reset) && isTransportError(refused)
    && !isTransportError(timeout) && !isTransportError(new TypeError('Invalid URL')));

  let clock = 0;
  const fake = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  const queue = (answers: Array<Response | Error>) => async () => {
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  let tries = 0;
  const counted = (inner: () => Promise<Response>) => async () => { tries++; return inner(); };
  tries = 0;
  const ok = await fetchWhileCompiling(counted(queue([reset, new Response(html500, { status: 500 }), new Response('', { status: 503 }), new Response('{"ok":true}', { status: 200 })])), { method: 'GET', ...fake });
  check('retry: recompiling (reset, HTML 500, 503) ends in the real answer', ok.response.status === 200 && ok.text === '{"ok":true}' && ok.retries === 3 && tries === 4, ok);
  tries = 0;
  clock = 0;
  const real = await fetchWhileCompiling(counted(queue([new Response('{"error":"boom"}', { status: 500 })])), { method: 'POST', ...fake });
  check('retry: a real failure is answered at once, sent once', real.response.status === 500 && tries === 1 && clock === 0);
  tries = 0;
  clock = 0;
  const forever = async () => { tries++; return new Response(html500, { status: 500 }); };
  const spent = await fetchWhileCompiling(forever, { method: 'GET', ...fake });
  check('retry: gives up within about a minute and returns the last answer', spent.response.status === 500 && clock <= 60_000 && clock > 30_000 && tries > 3 && tries < 40, { clock, tries });
  clock = 0;
  let thrown: unknown = null;
  try { await fetchWhileCompiling(queue([timeout]), { method: 'GET', ...fake }); } catch (e) { thrown = e; }
  check('retry: a timeout is thrown at once, not retried', thrown === timeout && clock === 0);
}

// ── Database-backed: 1 through withApi, 2 and 4 ─────────────────────────
async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const scout = await member('Scout', 'agent');
  const grant = async (memberId: string, permission: string, channel: 'app' | 'api') =>
    q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, $3, 'allow')
       ON CONFLICT (member_id, permission_key, access_channel) DO UPDATE SET effect = EXCLUDED.effect`, [memberId, permission, channel]);
  for (const p of ['tasks.read', 'webhooks.manage', 'api_keys.manage_all']) await grant(owner, p, 'api');
  for (const p of ['tasks.read', 'api_keys.manage_all']) await grant(scout, p, 'api');
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const rows = await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', $1, $2, $3, $3, $4, 'scoped') RETURNING id`, [secret.slice(0, 15), createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return { id: rows[0].id, secret };
  };
  return { q, owner, scout, key };
}

async function databaseChecks() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { strictColumns: true });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  delete process.env.APP_ENCRYPTION_KEY;
  // Every database round trip the app makes goes through fetch to the fake PostgREST.
  let dbCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(server.url)) dbCalls++;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { withApi } = await import('../src/lib/api/middleware');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { rotateApiKey } = await import('../src/lib/api/key-rotate');
    const { insertServerWebhookEndpoint, rotateWebhookSecret } = await import('../src/lib/api/webhook-endpoints');
    const { openWebhookSecret } = await import('../src/lib/webhooks/secret');
    const v1Hooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const service = getServiceClient();

    // ── 1. Wrong keys at the door ──
    const probe = withApi(async () => Response.json({ ok: true }), { permission: 'tasks.read' });
    const call = async (secret: string, ip: string | null) => {
      const headers: Record<string, string> = { 'x-api-key': secret };
      if (ip) headers['x-real-ip'] = ip;
      const response = await probe(new NextRequest('http://localhost/api/v1/tasks', { headers }));
      return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after') };
    };
    const owners = await s.key(s.owner, ['tasks.read']);
    resetBadKeyLimit();
    // Measured after a warm-up call, each after the last one's after-response writes (last used) settle.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    const callsFor = async (ip: string | null) => {
      await settle();
      dbCalls = 0;
      const answer = await call(owners.secret, ip);
      const n = dbCalls;
      return { ok: answer.status === 200, n };
    };
    await callsFor(null);
    const plain = await callsFor(null);
    const withAddress = await callsFor('203.0.113.7');
    check('door: a working key works with and without an address', plain.ok && withAddress.ok);
    check('door: a working key pays no extra database call for the limiter', withAddress.n === plain.n, { plain, withAddress });
    for (let i = 0; i < BAD_KEY_LIMIT; i++) {
      const miss = await call(`pk_live_${randomUUID().replace(/-/g, '')}`, '203.0.113.7');
      if (miss.status !== 401) { check(`door: wrong key ${i + 1} is 401 invalid_api_key`, false, miss); break; }
    }
    dbCalls = 0;
    const closed = await call(`pk_live_${randomUUID().replace(/-/g, '')}`, '203.0.113.7');
    check(`door: after ${BAD_KEY_LIMIT} wrong keys the address is 429 too_many_bad_keys, with Retry-After`, closed.status === 429
      && closed.body?.error?.details?.reason === 'too_many_bad_keys' && Number(closed.retryAfter) > 200, closed);
    check('door: the refusal makes no database call (before the key lookup)', dbCalls === 0, dbCalls);
    check('door: the same flood leaves other addresses alone', (await call(owners.secret, '198.51.100.1')).status === 200);
    resetBadKeyLimit();

    // ── 2. Rotation overlap ──
    const person = async (memberId: string, scopes: string[]) => {
      const access = (await resolveMemberAccess(service, memberId))!;
      return { caller: { memberId, access, scopes }, granter: { memberId, access, scopes }, apiKeyId: null, endpoint: 'test', via: 'rest' as const };
    };
    const hoursLeft = (expiresAt: string) => (Date.parse(expiresAt) - Date.now()) / 3_600_000;
    const scoutKey = await s.key(s.scout, ['tasks.read', 'api_keys.manage_all']);
    const own = await rotateApiKey(service, await person(s.scout, ['tasks.read', 'api_keys.manage_all']), scoutKey.id, { overlap_hours: 168 });
    const ownHours = hoursLeft(own.previous.expires_at);
    check('overlap: an agent replacing its own key keeps the old one 1 hour at most, even when it asks for 168', ownHours > 0.9 && ownHours <= 1.01, ownHours);
    const scoutKey2 = await s.key(s.scout, ['tasks.read', 'api_keys.manage_all']);
    const ownDefault = await rotateApiKey(service, await person(s.scout, ['tasks.read', 'api_keys.manage_all']), scoutKey2.id, {});
    check('overlap: by default it is 1 hour', Math.abs(hoursLeft(ownDefault.previous.expires_at) - 1) < 0.02, ownDefault.previous);
    const audit = (await s.q<Loose>("SELECT request_body FROM pm.api_audit_log WHERE entity_type = 'api_key' AND entity_id = $1", [own.key.id]))[0];
    check('overlap: the audit row records the hour it got', audit?.request_body?.overlap_hours === 1, audit);
    const scoutKey3 = await s.key(s.scout, ['tasks.read']);
    const byOwner = await rotateApiKey(service, await person(s.owner, ['tasks.read', 'api_keys.manage_all', 'webhooks.manage']), scoutKey3.id, { overlap_hours: 72 });
    check('overlap: an Owner rotating an agent\'s key still chooses up to 168 hours', Math.abs(hoursLeft(byOwner.previous.expires_at) - 72) < 0.05, byOwner.previous);
    const ownerKey = await s.key(s.owner, ['tasks.read']);
    const ownerOwn = await rotateApiKey(service, await person(s.owner, ['tasks.read', 'api_keys.manage_all', 'webhooks.manage']), ownerKey.id, {});
    check('overlap: a person replacing their own key keeps the 24 hour default', Math.abs(hoursLeft(ownerOwn.previous.expires_at) - 24) < 0.05, ownerOwn.previous);

    // ── 4. Webhook secrets without the app key ──
    const ownerAccess = (await resolveMemberAccess(service, s.owner))!;
    void ownerAccess;
    const count = async () => Number((await s.q<{ n: number }>('SELECT count(*)::int AS n FROM pm.webhook_endpoints'))[0].n);
    const fields = { name: 'Hook', url: 'https://hooks.example.com/in', secret: 'whsec_plain', events: ['task.created'], created_by: s.owner };
    let refused: Loose = null;
    try { await insertServerWebhookEndpoint(service, fields); } catch (e) { refused = e; }
    check('webhooks: a new endpoint without APP_ENCRYPTION_KEY is 409 encryption_key_missing, nothing written', refused?.statusCode === 409
      && refused?.details?.reason === 'encryption_key_missing' && (await count()) === 0, refused?.details);
    const hookKey = await s.key(s.owner, ['webhooks.manage']);
    const v1 = await v1Hooks.POST(new NextRequest('http://localhost/api/v1/webhook-endpoints', {
      method: 'POST', headers: { 'x-api-key': hookKey.secret, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hook', url: 'https://hooks.example.com/in', events: ['task.created'] }),
    }));
    const v1Body = await v1.json();
    check('webhooks: the v1 route says so too (409), and writes nothing', v1.status === 409 && v1Body?.error?.details?.reason === 'encryption_key_missing' && (await count()) === 0, v1Body);
    // An endpoint stored in plain text by an older release keeps signing, and keeps its secret when a new one is refused.
    const old = (await s.q<{ id: string }>("INSERT INTO pm.webhook_endpoints (name, url, secret, events, created_by) VALUES ('Old', 'https://hooks.example.com/old', 'whsec_legacy', '{task.created}', $1) RETURNING id", [s.owner]))[0].id;
    let rotateRefused: Loose = null;
    try { await rotateWebhookSecret(service, old); } catch (e) { rotateRefused = e; }
    const stored = (await s.q<{ secret: string }>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [old]))[0].secret;
    check('webhooks: a new signing secret without the key is refused and the old one stays', rotateRefused?.details?.reason === 'encryption_key_missing' && stored === 'whsec_legacy', rotateRefused?.details);
    check('webhooks: a plain-text secret stored before still opens to sign', openWebhookSecret(old, stored) === 'whsec_legacy');
    process.env.APP_ENCRYPTION_KEY = 'e'.repeat(64);
    const made = await insertServerWebhookEndpoint(service, fields);
    check('webhooks: with the key, the endpoint is made and its secret sealed', made.secret.startsWith('pm1:') && openWebhookSecret(made.id, made.secret) === 'whsec_plain');
    const fresh = await rotateWebhookSecret(service, old);
    const resealed = (await s.q<{ secret: string }>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [old]))[0].secret;
    check('webhooks: with the key, a new signing secret is sealed', resealed.startsWith('pm1:') && openWebhookSecret(old, resealed) === fresh);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.APP_ENCRYPTION_KEY;
    await server.close();
    await db.close();
  }
}

async function main() {
  badKeyPureChecks();
  nonceChecks();
  relayChecks();
  await retryChecks();
  await proxyChecks();
  await migrationRuns();
  await databaseChecks();
  if (failures.length) {
    console.error(`security leftovers: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`security leftovers: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
