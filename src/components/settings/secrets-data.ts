'use client';

import { peekRead, setReadData, warmRead, type Read } from '@/lib/query-cache';
import type { AppKeyState } from '@/lib/crypto/app-key';
import type { EncryptionStatus, ReencryptResult } from '@/lib/crypto/reencrypt';
import type { SecretName, SecretStatus } from '@/lib/secrets/store';

/**
 * The Owner's side of the app key and the secrets saved with it, shared by
 * Settings > Workspace > Encryption, Settings > Email > Receiving, Settings >
 * Updates and Settings > Developers > Webhook retries. One read per route, so
 * every card that shows a secret agrees, and every write puts the answer it
 * gets back in place. No route ever returns a value.
 */

export type { AppKeyState, SecretName, SecretStatus };

export interface SecretsState {
  appKey: AppKeyState;
  secrets: SecretStatus[];
}

export interface WebhookRetriesState {
  on: boolean;
  source: 'app' | 'env' | null;
  appKey: boolean;
  appUrl: boolean;
  vault: boolean;
}

/** Where Settings > Workspace > Encryption lives, for the cards that point there. */
export const ENCRYPTION_HREF = '/settings/workspace#encryption';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Could not reach the server. Try again in a moment.');
  return payload.data as T;
}

const send = (path: string, method: 'POST' | 'DELETE', body: unknown = {}) =>
  fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });

// The host's environment and the app's own saves are the only things that
// change these, so no table makes them stale: a minute keeps a revisit instant.
export const secretsRead: Read<SecretsState> = {
  key: 'workspace-secrets',
  tables: [],
  ttlMs: 60_000,
  load: async () => parse<SecretsState>(await fetch('/api/workspace/secrets', { cache: 'no-store' })),
};

export const encryptionRead: Read<EncryptionStatus> = {
  key: 'workspace-encryption',
  tables: [],
  ttlMs: 60_000,
  load: async () => parse<EncryptionStatus>(await fetch('/api/workspace/encryption', { cache: 'no-store' })),
};

export const webhookRetriesRead: Read<WebhookRetriesState> = {
  key: 'workspace-webhook-retries',
  tables: [],
  ttlMs: 60_000,
  load: async () => parse<WebhookRetriesState>(await fetch('/api/workspace/webhook-retries', { cache: 'no-store' })),
};

/** Saves one secret in the app; the state it answers with replaces the one on screen. */
export async function saveSecret(name: SecretName, value: string): Promise<SecretsState> {
  const data = await parse<SecretsState>(await send('/api/workspace/secrets', 'POST', { name, value }));
  setReadData(secretsRead, () => data);
  return data;
}

/** Removes one secret saved in the app; the host's variable, if any, answers again. */
export async function removeSecret(name: SecretName): Promise<SecretsState> {
  const data = await parse<SecretsState>(await send('/api/workspace/secrets', 'DELETE', { name }));
  setReadData(secretsRead, () => data);
  return data;
}

/** Moves values sealed with the older keys onto the app key. */
export async function moveToAppKey(): Promise<ReencryptResult> {
  const result = await parse<ReencryptResult>(await send('/api/workspace/encryption', 'POST'));
  setReadData(encryptionRead, () => result.status);
  return result;
}

/** Turns webhook retries on: the server makes the secret, saves it and hands it to Vault. */
export async function turnOnWebhookRetries(): Promise<WebhookRetriesState> {
  const data = await parse<WebhookRetriesState>(await send('/api/workspace/webhook-retries', 'POST'));
  setReadData(webhookRetriesRead, () => data);
  // The scheduler secret is one of the saved secrets: keep that read in step when it is cached.
  if (peekRead(secretsRead)) void warmRead(secretsRead, { force: true });
  return data;
}

/** One secret's status out of the read, or a not-set placeholder while it loads. */
export function secretStatus(state: SecretsState | undefined, name: SecretName): SecretStatus {
  return state?.secrets.find((secret) => secret.name === name) ?? { name, source: null, updatedAt: null, unreadable: false };
}
