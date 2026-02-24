/**
 * Server-side encryption module (AES-256-GCM) for project credentials.
 *
 * Uses the PROJECT_CREDENTIALS_ENCRYPTION_KEY environment variable.
 * The encrypt/decrypt functions are generic and can be adapted for
 * other features (e.g. SMTP config) with their own env var keys.
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

let cachedKey: CryptoKey | null = null;
let cachedHex: string | null = null;

export function isEncryptionConfigured(): boolean {
  const hex = process.env.PROJECT_CREDENTIALS_ENCRYPTION_KEY;
  return typeof hex === 'string' && hex.length === 64;
}

async function getMasterKey(): Promise<CryptoKey> {
  const hex = process.env.PROJECT_CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('PROJECT_CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
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
  const key = await getMasterKey();
  const cipherBytes = base64ToBuffer(encryptedData);
  const ivBytes = base64ToBuffer(iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: ivBytes }, key, cipherBytes,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// ---------------------------------------------------------------------------
// Key generation helper (used by the setup API)
// ---------------------------------------------------------------------------

export function generateEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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
