import type { SupabaseClient } from '@supabase/supabase-js';
import { appKeyReady, open, seal } from '@/lib/crypto/app-key';

/**
 * Integration secrets an Owner sets in the app (pm.app_secrets), with the
 * host's environment variable as the fallback. Values are sealed with the app
 * key, bound to their name, before they reach the database, and are only ever
 * opened on the server. Reading prefers the app, then the environment, and
 * says which one answered, so Settings can show it (never the value).
 */

export const SECRET_NAMES = ['resend_api_key', 'resend_webhook_secret', 'github_token', 'github_repo', 'webhook_scheduler_secret'] as const;
export type SecretName = typeof SECRET_NAMES[number];

/** The environment variable each one used to need, still read as a fallback. */
export const SECRET_ENV: Record<SecretName, string> = {
  resend_api_key: 'RESEND_API_KEY',
  resend_webhook_secret: 'RESEND_INBOUND_WEBHOOK_SECRET',
  github_token: 'PM_GITHUB_TOKEN',
  github_repo: 'PM_GITHUB_REPO',
  webhook_scheduler_secret: 'WEBHOOK_SCHEDULER_SECRET',
};

export type SecretSource = 'app' | 'env' | null;

export interface SecretStatus {
  name: SecretName;
  source: SecretSource;
  /** When it was saved in the app; null when it comes from the environment or is not set. */
  updatedAt: string | null;
  /** Saved in the app, but the app key is missing or changed, so it cannot be opened. */
  unreadable: boolean;
}

type Env = Record<string, string | undefined>;
type Row = { name: SecretName; value: string; updated_at: string };

// Webhooks and inbound mail read these on every call; a short cache keeps that
// to one query a minute per server instance. Writes clear it.
const CACHE_MS = 60_000;
let cache: { at: number; rows: Map<SecretName, Row> } | null = null;

export function clearSecretCache(): void {
  cache = null;
}

async function rows(service: SupabaseClient): Promise<Map<SecretName, Row>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const { data, error } = await service.from('app_secrets').select('name, value, updated_at');
  // Not migrated yet (1.9 database): nothing saved in the app, so the environment answers.
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code ?? '') || /does not exist|could not find the table/i.test(error.message ?? '')) {
      cache = { at: Date.now(), rows: new Map() };
      return cache.rows;
    }
    throw error;
  }
  const map = new Map<SecretName, Row>();
  for (const row of (data ?? []) as Row[]) map.set(row.name, row);
  cache = { at: Date.now(), rows: map };
  return map;
}

function envValue(name: SecretName, env: Env): string | null {
  const raw = env[SECRET_ENV[name]]?.trim();
  return raw ? raw : null;
}

/** The secret's value: saved in the app first, then the environment, else null. */
export async function readSecret(service: SupabaseClient, name: SecretName, env: Env = process.env): Promise<string | null> {
  const row = (await rows(service)).get(name);
  if (row && appKeyReady(env)) {
    try {
      return open('secrets', row.value, name, env);
    } catch {
      // Saved under a different key: fall back to the environment rather than fail.
    }
  }
  return envValue(name, env);
}

/** Saved in the app (whether or not it can be opened right now). */
export async function savedInApp(service: SupabaseClient, name: SecretName): Promise<boolean> {
  return (await rows(service)).has(name);
}

export async function readSecrets<K extends SecretName>(service: SupabaseClient, names: readonly K[], env: Env = process.env): Promise<Record<K, string | null>> {
  const out = {} as Record<K, string | null>;
  await Promise.all(names.map(async (name) => { out[name] = await readSecret(service, name, env); }));
  return out;
}

export async function secretStatuses(service: SupabaseClient, env: Env = process.env): Promise<SecretStatus[]> {
  const saved = await rows(service);
  return SECRET_NAMES.map((name) => {
    const row = saved.get(name);
    if (row) {
      let unreadable = !appKeyReady(env);
      if (!unreadable) {
        try { open('secrets', row.value, name, env); } catch { unreadable = true; }
      }
      if (!unreadable) return { name, source: 'app', updatedAt: row.updated_at, unreadable: false };
      return { name, source: envValue(name, env) ? 'env' : null, updatedAt: row.updated_at, unreadable: true };
    }
    return { name, source: envValue(name, env) ? 'env' : null, updatedAt: null, unreadable: false };
  });
}

export class SecretError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Saves (or replaces) a secret in the app, sealed with the app key. Refused without the key. */
export async function writeSecret(service: SupabaseClient, name: SecretName, value: string, memberId: string | null, env: Env = process.env): Promise<void> {
  if (!appKeyReady(env)) throw new SecretError(409, 'Add APP_ENCRYPTION_KEY to your host first: secrets saved in the app are encrypted with it.');
  const trimmed = value.trim();
  if (!trimmed) throw new SecretError(422, 'Enter a value.');
  if (trimmed.length > 4096) throw new SecretError(422, 'That value is too long.');
  const { error } = await service.from('app_secrets').upsert(
    { name, value: seal('secrets', trimmed, name, env), updated_at: new Date().toISOString(), updated_by: memberId },
    { onConflict: 'name' },
  );
  clearSecretCache();
  if (error) throw new SecretError(500, error.message);
}

/** Removes a secret saved in the app; the environment variable, if any, answers again. */
export async function clearSecret(service: SupabaseClient, name: SecretName): Promise<void> {
  const { error } = await service.from('app_secrets').delete().eq('name', name);
  clearSecretCache();
  if (error) throw new SecretError(500, error.message);
}
