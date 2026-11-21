import crypto from 'crypto';
import { appKeyReady, isAppSealed, open, seal } from '@/lib/crypto/app-key';

/**
 * Email account passwords (smtp_accounts.encrypted_password).
 *
 * New values are sealed with the app key (APP_ENCRYPTION_KEY, purpose
 * "smtp"). Values saved before it, under SMTP_ENCRYPTION_KEY, still open
 * while that variable is set; the re-encrypt (Settings > Workspace >
 * Encryption) moves them across. Until the app key is set, new values keep
 * using SMTP_ENCRYPTION_KEY, so a running install never breaks.
 */

const LEGACY_ALGORITHM = 'aes-256-gcm';
const LEGACY_IV_LENGTH = 12;

function legacyKey(): Buffer {
  const envKey = process.env.SMTP_ENCRYPTION_KEY;
  if (!envKey) throw new Error('No encryption key: set APP_ENCRYPTION_KEY in your host');
  return crypto.createHash('sha256').update(envKey).digest();
}

function legacyEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(LEGACY_IV_LENGTH);
  const cipher = crypto.createCipheriv(LEGACY_ALGORITHM, legacyKey(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function legacyDecrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, legacyKey(), Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function encrypt(plaintext: string): string {
  return appKeyReady() ? seal('smtp', plaintext) : legacyEncrypt(plaintext);
}

export function decrypt(encrypted: string): string {
  return isAppSealed(encrypted) ? open('smtp', encrypted) : legacyDecrypt(encrypted);
}

/** A value still sealed under SMTP_ENCRYPTION_KEY (the re-encrypt moves it). */
export function isLegacySmtpValue(encrypted: string | null | undefined): boolean {
  return typeof encrypted === 'string' && encrypted.length > 0 && !isAppSealed(encrypted);
}

/** Email passwords can be saved: the app key, or the older SMTP key, is set. */
export function isSmtpEncryptionConfigured(): boolean {
  return appKeyReady() || !!process.env.SMTP_ENCRYPTION_KEY;
}
