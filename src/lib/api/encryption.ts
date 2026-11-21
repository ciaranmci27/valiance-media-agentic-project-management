/**
 * Project credentials (project_credentials.encrypted_data and iv).
 *
 * New values are sealed with the app key (APP_ENCRYPTION_KEY, purpose
 * "credentials"): encrypted_data holds the sealed value and iv the marker
 * "pm1". Values saved before it, under PROJECT_CREDENTIALS_ENCRYPTION_KEY,
 * still open while that variable is set; the re-encrypt moves them across.
 * Until the app key is set, new values keep using the older key, so a
 * running install never breaks.
 */
import { appKeyReady, isAppSealed, open, seal } from '@/lib/crypto/app-key';

/** The iv column's value for credentials sealed with the app key (the nonce lives inside the sealed value). */
export const APP_SEALED_IV = 'pm1';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

let cachedKey: CryptoKey | null = null;
let cachedHex: string | null = null;

function legacyConfigured(): boolean {
  const hex = process.env.PROJECT_CREDENTIALS_ENCRYPTION_KEY;
  return typeof hex === 'string' && hex.length === 64;
}

/** Credentials can be saved: the app key, or the older credentials key, is set. */
export function isEncryptionConfigured(): boolean {
  return appKeyReady() || legacyConfigured();
}

/** A credential still sealed under PROJECT_CREDENTIALS_ENCRYPTION_KEY (the re-encrypt moves it). */
export function isLegacyCredential(encryptedData: string | null | undefined): boolean {
  return typeof encryptedData === 'string' && encryptedData.length > 0 && !isAppSealed(encryptedData);
}

async function getMasterKey(): Promise<CryptoKey> {
  const hex = process.env.PROJECT_CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('No encryption key: set APP_ENCRYPTION_KEY in your host (64 hex characters)');
  }
  // Return cached key if env var hasn't changed
  if (cachedKey && cachedHex === hex) return cachedKey;

  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  cachedKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: ALGORITHM }, false, ['encrypt', 'decrypt'],
  );
  cachedHex = hex;
  return cachedKey;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt — works with any JSON-serializable payload
// ---------------------------------------------------------------------------

export async function encrypt<T>(payload: T): Promise<{ encrypted_data: string; iv: string }> {
  if (appKeyReady()) return { encrypted_data: seal('credentials', JSON.stringify(payload)), iv: APP_SEALED_IV };
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv }, key, encoded,
  );
  return {
    encrypted_data: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

export async function decrypt<T>(encryptedData: string, iv: string): Promise<T> {
  if (isAppSealed(encryptedData)) return JSON.parse(open('credentials', encryptedData)) as T;
  const key = await getMasterKey();
  const cipherBytes = base64ToBuffer(encryptedData);
  const ivBytes = base64ToBuffer(iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: ivBytes }, key, cipherBytes,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
