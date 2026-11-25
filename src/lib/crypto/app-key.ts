import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * One encryption key for the whole app (APP_ENCRYPTION_KEY, 64 hex characters,
 * set in the host). Every use gets its own key derived from it (HKDF-SHA256
 * with a purpose label), so it is one secret to manage while a key derived
 * for one use opens nothing else.
 *
 * Values sealed with it read `pm1:<iv>.<tag>.<ciphertext>` (base64url), so a
 * reader can tell them from values sealed under the older per-feature keys
 * (SMTP_ENCRYPTION_KEY, PROJECT_CREDENTIALS_ENCRYPTION_KEY), which keep
 * opening until the re-encrypt has moved everything across.
 *
 * AES-256-GCM with a random 96-bit nonce; `aad` binds a value to where it is
 * stored (a setting's name), so a sealed value cannot be moved between them.
 * Losing the key loses every value sealed with it: there is no recovery.
 */

export type KeyPurpose = 'smtp' | 'credentials' | 'secrets' | 'webhooks' | 'chat';

export const APP_KEY_ENV = 'APP_ENCRYPTION_KEY';
const PREFIX = 'pm1:';
const HEX_64 = /^[0-9a-fA-F]{64}$/;

type Env = Record<string, string | undefined>;

export type AppKeyState = 'set' | 'invalid' | 'missing';

/** Whether the host has a usable APP_ENCRYPTION_KEY. Says so, never the value. */
export function appKeyState(env: Env = process.env): AppKeyState {
  const raw = env[APP_KEY_ENV]?.trim();
  if (!raw) return 'missing';
  return HEX_64.test(raw) ? 'set' : 'invalid';
}

export function appKeyReady(env: Env = process.env): boolean {
  return appKeyState(env) === 'set';
}

const derivedCache = new Map<string, Buffer>();

function derivedKey(purpose: KeyPurpose, env: Env): Buffer {
  const raw = env[APP_KEY_ENV]?.trim();
  if (!raw || !HEX_64.test(raw)) throw new Error('APP_ENCRYPTION_KEY is not set (64 hex characters)');
  const cacheKey = `${purpose}:${raw}`;
  const cached = derivedCache.get(cacheKey);
  if (cached) return cached;
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.from('pm-app-key'), Buffer.from(`pm:${purpose}:v1`), 32));
  // A handful of entries at most: one per purpose (and per key, if the host's key changes).
  derivedCache.set(cacheKey, key);
  return key;
}

/** True for a value sealed with the app key (as opposed to an older per-feature key). */
export function isAppSealed(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function seal(purpose: KeyPurpose, plaintext: string, aad = '', env: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(purpose, env), iv);
  cipher.setAAD(Buffer.from(`${purpose}|${aad}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function open(purpose: KeyPurpose, sealed: string, aad = '', env: Env = process.env): string {
  if (!isAppSealed(sealed)) throw new Error('Not sealed with the app key');
  const [ivPart, tagPart, dataPart] = sealed.slice(PREFIX.length).split('.');
  if (!ivPart || !tagPart || dataPart === undefined) throw new Error('Malformed sealed value');
  const iv = Buffer.from(ivPart, 'base64url');
  if (iv.length !== 12) throw new Error('Malformed sealed value');
  // A full 16-byte tag only: Node would otherwise accept truncated ones.
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(purpose, env), iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(`${purpose}|${aad}`));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

/** A new random key, for the setup screens: 32 bytes as 64 hex characters. */
export function generateAppKey(): string {
  return randomBytes(32).toString('hex');
}
