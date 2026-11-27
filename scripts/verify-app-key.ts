/**
 * One app key and secrets in the app (1.10):
 * - APP_ENCRYPTION_KEY: its state, sealing and opening, a key per purpose,
 *   values bound to where they are stored;
 * - email passwords and project credentials: new values use the app key,
 *   values saved under the older keys still open, and installs without the
 *   app key keep working on the older keys;
 * - the re-encrypt moves everything onto the app key and is safe to rerun;
 * - integration secrets: the app first, then the host's variable, which one
 *   answered, refused without the key, never readable by API roles;
 * - the scheduler takes a secret saved in the app;
 * - the setup checks: the app key is required and shape-checked, and the
 *   wizard's "Connect your server" lists only what it should.
 *
 *   npm run -s test:app-key
 */
import { randomBytes } from 'node:crypto';
import { appKeyState, generateAppKey, isAppSealed, open, seal } from '../src/lib/crypto/app-key';
import { envChecks, missingServerSettings, supabaseConnected } from '../src/lib/setup/checks';
import { internalAuthorization } from '../src/lib/webhooks/internal-auth';
import { actAs, createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');
const LEGACY_SMTP = 'an-old-smtp-key-of-any-shape';
const LEGACY_CREDS = randomBytes(32).toString('hex');

function setEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// ---- The key itself --------------------------------------------------------
function key() {
  check('state: missing', appKeyState({}) === 'missing');
  check('state: invalid when not 64 hex', appKeyState({ APP_ENCRYPTION_KEY: 'short' }) === 'invalid' && appKeyState({ APP_ENCRYPTION_KEY: 'z'.repeat(64) }) === 'invalid');
  check('state: set', appKeyState({ APP_ENCRYPTION_KEY: KEY_A }) === 'set');
  check('generate: 64 hex', /^[0-9a-f]{64}$/.test(generateAppKey()));
  const env = { APP_ENCRYPTION_KEY: KEY_A };
  const sealed = seal('secrets', 'hello', 'resend_api_key', env);
  check('seal: marked pm1 and not the plaintext', isAppSealed(sealed) && !sealed.includes('hello'));
  check('seal: a fresh nonce each time', seal('secrets', 'hello', 'resend_api_key', env) !== sealed);
  check('open: round trip', open('secrets', sealed, 'resend_api_key', env) === 'hello');
  check('open: bound to its name', throws(() => open('secrets', sealed, 'github_token', env)));
  check('open: a key per purpose', throws(() => open('smtp', sealed, 'resend_api_key', env)));
  check('open: another key cannot open it', throws(() => open('secrets', sealed, 'resend_api_key', { APP_ENCRYPTION_KEY: KEY_B })));
  check('open: refuses without the key', throws(() => open('secrets', sealed, 'resend_api_key', {})));
  // Change a character in the middle: the last base64 characters can carry padding bits that decode to the same bytes.
  const mid = Math.floor(sealed.length / 2);
  const tampered = sealed.slice(0, mid) + (sealed[mid] === 'A' ? 'B' : 'A') + sealed.slice(mid + 1);
  check('open: tampering is caught', throws(() => open('secrets', tampered, 'resend_api_key', env)));
  const [ivPart, tagPart, dataPart] = sealed.slice(4).split('.');
  const shortTag = `pm1:${ivPart}.${Buffer.from(tagPart, 'base64url').subarray(0, 4).toString('base64url')}.${dataPart}`;
  check('open: a shortened tag is refused', throws(() => open('secrets', shortTag, 'resend_api_key', env)));
  const shortIv = `pm1:${Buffer.from(ivPart, 'base64url').subarray(0, 8).toString('base64url')}.${tagPart}.${dataPart}`;
  check('open: a wrong-length nonce is refused', throws(() => open('secrets', shortIv, 'resend_api_key', env)));
}

// ---- Email passwords and credentials, old keys and new --------------------
async function features() {
  const smtp = await import('../src/lib/email/crypto');
  const creds = await import('../src/lib/api/encryption');

  setEnv({ APP_ENCRYPTION_KEY: undefined, SMTP_ENCRYPTION_KEY: LEGACY_SMTP, PROJECT_CREDENTIALS_ENCRYPTION_KEY: LEGACY_CREDS });
  const oldPassword = smtp.encrypt('mail-pass');
  const oldCredential = await creds.encrypt({ user: 'u', pass: 'p' });
  check('no app key: email passwords use the older key, as before', !isAppSealed(oldPassword) && smtp.isLegacySmtpValue(oldPassword));
  check('no app key: credentials use the older key, as before', !isAppSealed(oldCredential.encrypted_data) && oldCredential.iv !== creds.APP_SEALED_IV);
  check('no app key: both count as configured', smtp.isSmtpEncryptionConfigured() && creds.isEncryptionConfigured());

  setEnv({ APP_ENCRYPTION_KEY: KEY_A });
  check('app key: old email passwords still open', smtp.decrypt(oldPassword) === 'mail-pass');
  check('app key: old credentials still open', JSON.stringify(await creds.decrypt(oldCredential.encrypted_data, oldCredential.iv)) === JSON.stringify({ user: 'u', pass: 'p' }));
  const newPassword = smtp.encrypt('mail-pass-2');
  const newCredential = await creds.encrypt({ user: 'v' });
  check('app key: new email passwords use it', isAppSealed(newPassword) && smtp.decrypt(newPassword) === 'mail-pass-2');
  check('app key: new credentials use it', isAppSealed(newCredential.encrypted_data) && newCredential.iv === creds.APP_SEALED_IV
    && (await creds.decrypt<{ user: string }>(newCredential.encrypted_data, newCredential.iv)).user === 'v');

  setEnv({ SMTP_ENCRYPTION_KEY: undefined, PROJECT_CREDENTIALS_ENCRYPTION_KEY: undefined });
  check('app key alone: configured for both', smtp.isSmtpEncryptionConfigured() && creds.isEncryptionConfigured());
  check('app key alone: new values still open', smtp.decrypt(newPassword) === 'mail-pass-2');
  setEnv({ APP_ENCRYPTION_KEY: undefined });
  check('no key at all: neither is configured', !smtp.isSmtpEncryptionConfigured() && !creds.isEncryptionConfigured());
}

// ---- The database: secrets, re-encrypt, who can read --------------------
async function database() {
  const db = await createFullSchemaDatabase();
  const server = await startFakePostgrest(db);
  setEnv({ NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', APP_ENCRYPTION_KEY: undefined,
    SMTP_ENCRYPTION_KEY: LEGACY_SMTP, PROJECT_CREDENTIALS_ENCRYPTION_KEY: LEGACY_CREDS, RESEND_API_KEY: 're_from_host', RESEND_INBOUND_WEBHOOK_SECRET: undefined });
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const store = await import('../src/lib/secrets/store');
    const smtp = await import('../src/lib/email/crypto');
    const creds = await import('../src/lib/api/encryption');
    const { encryptionStatus, reencryptAll } = await import('../src/lib/crypto/reencrypt');
    const service = getServiceClient();
    store.clearSecretCache();

    check('secrets: the host variable answers when nothing is saved', await store.readSecret(service, 'resend_api_key') === 're_from_host');
    const before = (await store.secretStatuses(service)).find((s) => s.name === 'resend_api_key');
    check('secrets: says it comes from the host', before?.source === 'env' && before.updatedAt === null);
    let refused = '';
    try { await store.writeSecret(service, 'resend_api_key', 're_saved', null); } catch (error) { refused = (error as Error).message; }
    check('secrets: saving is refused without the app key', /APP_ENCRYPTION_KEY/.test(refused), refused);

    setEnv({ APP_ENCRYPTION_KEY: KEY_A });
    await store.writeSecret(service, 'resend_api_key', '  re_saved  ', null);
    check('secrets: saved in the app answers first (trimmed)', await store.readSecret(service, 'resend_api_key') === 're_saved');
    const stored = (await db.query<{ value: string }>("SELECT value FROM pm.app_secrets WHERE name = 'resend_api_key'")).rows[0]?.value ?? '';
    check('secrets: the database holds only ciphertext', isAppSealed(stored) && !stored.includes('re_saved'));
    const after = (await store.secretStatuses(service)).find((s) => s.name === 'resend_api_key');
    check('secrets: says it is saved in the app, with a date', after?.source === 'app' && !!after.updatedAt && !after.unreadable);
    check('secrets: statuses never carry a value', !JSON.stringify(await store.secretStatuses(service)).includes('re_saved'));

    setEnv({ APP_ENCRYPTION_KEY: KEY_B });
    store.clearSecretCache();
    check('secrets: under another key, the host variable answers instead', await store.readSecret(service, 'resend_api_key') === 're_from_host');
    const unreadable = (await store.secretStatuses(service)).find((s) => s.name === 'resend_api_key');
    check('secrets: and it says the saved one cannot be read', unreadable?.unreadable === true && unreadable.source === 'env');
    setEnv({ APP_ENCRYPTION_KEY: KEY_A });
    store.clearSecretCache();
    await store.clearSecret(service, 'resend_api_key');
    check('secrets: removing it lets the host answer again', await store.readSecret(service, 'resend_api_key') === 're_from_host');

    // API roles never see the table.
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000c1', 'owner@x.co')`);
    await store.writeSecret(service, 'github_token', 'ghp_x', null);
    await actAs(db, '00000000-0000-0000-0000-0000000000c1');
    let denied = '';
    try { await db.query('SELECT * FROM pm.app_secrets'); } catch (error) { denied = (error as Error).message; }
    await actAs(db, null);
    await db.exec('RESET ROLE');
    check('secrets: a signed-in member (even the Owner) cannot read the table', /permission denied/.test(denied), denied);
    let plain = '';
    try { await db.exec("INSERT INTO pm.app_secrets (name, value) VALUES ('github_repo', 'acme/app')"); } catch (error) { plain = (error as Error).message; }
    check('secrets: the table refuses an unsealed value', /check constraint/.test(plain), plain);

    // Re-encrypt: rows sealed under the older keys move onto the app key.
    setEnv({ APP_ENCRYPTION_KEY: undefined });
    const legacyPassword = smtp.encrypt('pw-1');
    const legacyCredential = await creds.encrypt({ secret: 'c-1' });
    setEnv({ APP_ENCRYPTION_KEY: KEY_A });
    const project = (await db.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('P') RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO pm.smtp_accounts (label, host, port, secure, username, encrypted_password, from_name, from_email)
      VALUES ('Old', 'smtp.x.co', 465, true, 'u', $1, 'X', 'x@x.co')`, [legacyPassword]);
    await db.query(`INSERT INTO pm.project_credentials (project_id, label, encrypted_data, iv) VALUES ($1, 'Old', $2, $3)`,
      [project, legacyCredential.encrypted_data, legacyCredential.iv]);
    const status = await encryptionStatus(service);
    check('re-encrypt: counts what still uses the older keys', status.remaining.smtp === 1 && status.remaining.credentials === 1, status);
    check('re-encrypt: names the older keys the host still has', status.legacyKeys.includes('SMTP_ENCRYPTION_KEY') && status.appKey === 'set');
    const moved = await reencryptAll(service);
    check('re-encrypt: moves both', moved.moved.smtp === 1 && moved.moved.credentials === 1 && moved.status.remaining.smtp === 0 && moved.status.remaining.credentials === 0, moved);
    const row = (await db.query<{ encrypted_password: string }>("SELECT encrypted_password FROM pm.smtp_accounts WHERE label = 'Old'")).rows[0];
    const cred = (await db.query<{ encrypted_data: string; iv: string }>("SELECT encrypted_data, iv FROM pm.project_credentials WHERE label = 'Old'")).rows[0];
    check('re-encrypt: values are the same, now on the app key', isAppSealed(row.encrypted_password) && smtp.decrypt(row.encrypted_password) === 'pw-1'
      && isAppSealed(cred.encrypted_data) && (await creds.decrypt<{ secret: string }>(cred.encrypted_data, cred.iv)).secret === 'c-1');
    setEnv({ SMTP_ENCRYPTION_KEY: undefined, PROJECT_CREDENTIALS_ENCRYPTION_KEY: undefined });
    check('re-encrypt: they open with the app key alone', smtp.decrypt(row.encrypted_password) === 'pw-1');
    const again = await reencryptAll(service);
    check('re-encrypt: running it again changes nothing', again.moved.smtp === 0 && again.moved.credentials === 0);

    // Rows the older keys can't open are left alone, counted, and never stop the rest.
    for (let i = 0; i < 4; i += 1) {
      await db.query(`INSERT INTO pm.smtp_accounts (label, host, port, secure, username, encrypted_password, from_name, from_email)
        VALUES ($1, 'smtp.x.co', 465, true, 'u', $2, 'X', 'x@x.co')`, [`Broken ${i}`, 'aa:bb:cc']);
    }
    setEnv({ SMTP_ENCRYPTION_KEY: LEGACY_SMTP });
    setEnv({ APP_ENCRYPTION_KEY: undefined });
    const goodLegacy = smtp.encrypt('pw-ok');
    setEnv({ APP_ENCRYPTION_KEY: KEY_A });
    await db.query(`INSERT INTO pm.smtp_accounts (label, host, port, secure, username, encrypted_password, from_name, from_email)
      VALUES ('Good', 'smtp.x.co', 465, true, 'u', $1, 'X', 'x@x.co')`, [goodLegacy]);
    const mixed = await reencryptAll(service);
    check('re-encrypt: unopenable rows are counted and the rest still move', mixed.failed.smtp.length === 4 && mixed.moved.smtp === 1 && mixed.status.remaining.smtp === 4, { moved: mixed.moved, failed: mixed.failed.smtp.length, remaining: mixed.status.remaining });
    const rerun = await reencryptAll(service);
    check('re-encrypt: and a rerun ends cleanly, still counting them', rerun.failed.smtp.length === 4 && rerun.moved.smtp === 0);
  } finally {
    await server.close?.();
    await db.close();
  }
}

// ---- The scheduler and the setup checks ---------------------------------
function scheduler() {
  const request = (token: string) => new Request('https://pm.example.com/api/internal/webhooks/scheduled', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const base = { SUPABASE_SERVICE_ROLE_KEY: 'k', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' };
  const savedSecret = 's'.repeat(40);
  check('scheduler: off with nothing set', internalAuthorization(request(savedSecret), 'scheduler', base)?.status === 404);
  check('scheduler: a secret saved in the app turns it on and is accepted',
    internalAuthorization(request(savedSecret), 'scheduler', base, { secret: savedSecret, enabled: true }) === null);
  check('scheduler: a wrong token is refused', internalAuthorization(request('t'.repeat(40)), 'scheduler', base, { secret: savedSecret, enabled: true })?.status === 401);
  check('scheduler: the saved one wins over the host\'s', internalAuthorization(request('h'.repeat(40)), 'scheduler',
    { ...base, WEBHOOK_SCHEDULER_ENABLED: 'true', WEBHOOK_SCHEDULER_SECRET: 'h'.repeat(40) }, { secret: savedSecret, enabled: true })?.status === 401);
  check('scheduler: the host\'s still works alone', internalAuthorization(request('h'.repeat(40)), 'scheduler',
    { ...base, WEBHOOK_SCHEDULER_ENABLED: 'true', WEBHOOK_SCHEDULER_SECRET: 'h'.repeat(40) }) === null);

  const full = { NEXT_PUBLIC_SUPABASE_URL: 'u', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', NEXT_PUBLIC_APP_URL: 'https://pm.x.co', APP_ENCRYPTION_KEY: KEY_A };
  const item = (env: Record<string, string>) => envChecks(env, { crons: false }).find((c) => c.name === 'APP_ENCRYPTION_KEY');
  check('setup: the app key is required', item(full)?.required === true && item(full)?.set === true);
  check('setup: a wrong-shaped key counts as not set', item({ ...full, APP_ENCRYPTION_KEY: 'nope' })?.set === false);
  check('setup: the older keys are no longer listed', !envChecks(full, { crons: false }).some((c) => /SMTP_ENCRYPTION_KEY|PROJECT_CREDENTIALS/.test(c.name)));
  check('setup: nothing missing when all is set', missingServerSettings(full).length === 0);
  const missing = missingServerSettings({ ...full, APP_ENCRYPTION_KEY: 'nope', NEXT_PUBLIC_APP_URL: '' });
  check('setup: lists the missing ones, flags a bad key', missing.map((m) => m.name).sort().join() === 'APP_ENCRYPTION_KEY,NEXT_PUBLIC_APP_URL' && missing.find((m) => m.name === 'APP_ENCRYPTION_KEY')?.invalid === true, missing);
  check('setup: the Supabase three are not on that list', missingServerSettings({ NEXT_PUBLIC_APP_URL: 'x', APP_ENCRYPTION_KEY: KEY_A }).length === 0);
  check('setup: Supabase connected needs all three', supabaseConnected(full) && !supabaseConnected({ ...full, SUPABASE_SERVICE_ROLE_KEY: ' ' }));
  check('setup: never carries a value', !JSON.stringify(envChecks(full, { crons: true })).includes(KEY_A));
}

// ---- Without the Supabase settings, every page goes to the setup page ----
async function setupPage() {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  setEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined, NEXT_PUBLIC_DEMO_MODE: undefined, DEMO_MODE: undefined });
  const { NextRequest } = await import('next/server');
  const { updateSession } = await import('../src/lib/supabase/middleware');
  const page = await updateSession(new NextRequest('http://localhost:3039/dashboard?x=1'));
  check('setup page: a page is shown the setup page', (page.headers.get('x-middleware-rewrite') ?? '').endsWith('/setup-required'), page.headers.get('x-middleware-rewrite'));
  const itself = await updateSession(new NextRequest('http://localhost:3039/setup-required'));
  check('setup page: the page itself loads', !itself.headers.get('x-middleware-rewrite') && itself.status === 200);
  const api = await updateSession(new NextRequest('http://localhost:3039/api/workspace/me'));
  check('setup page: an API call answers 503, not a crash', api.status === 503);
  const icon = await updateSession(new NextRequest('http://localhost:3039/api/brand/icon'));
  check('setup page: the favicon still loads', icon.status === 200 && !icon.headers.get('x-middleware-rewrite'));
  setEnv({ NEXT_PUBLIC_SUPABASE_URL: saved.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: saved.anon });
}

async function main() {
  key();
  await setupPage();
  await features();
  await database();
  scheduler();
  if (failures.length) {
    console.error(`app key: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`app key: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
