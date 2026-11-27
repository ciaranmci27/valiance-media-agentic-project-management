import type { SupabaseClient } from '@supabase/supabase-js';
import { appKeyReady, isAppSealed, open, seal } from '@/lib/crypto/app-key';
import { ApiError } from '@/lib/api/errors';

/**
 * Webhook signing secrets at rest (webhook_endpoints.secret). The server
 * seals a secret with the app key (APP_ENCRYPTION_KEY, purpose "webhooks",
 * bound to its endpoint's id) when the host has the key, and the dispatcher
 * opens it to sign each delivery. A new endpoint or a new signing secret
 * needs the key (assertWebhookKey, 409 encryption_key_missing), as app
 * secrets do: nothing new is stored in plain text. Secrets stored in plain
 * text before (without the key, or by an older release's browser) keep
 * working, Settings > Workspace > Encryption counts them, and they are
 * sealed in place the next time the server loads one with the key set (a
 * delivery, or Settings revealing it), and Settings > Encryption moves the
 * rest at once. Every release since 2.0.25 opens sealed secrets, so a
 * rollback still signs. Server only.
 */

type Env = Record<string, string | undefined>;

/** 409 encryption_key_missing unless the host has APP_ENCRYPTION_KEY: a new signing secret is only stored encrypted. */
export function assertWebhookKey(env: Env = process.env): void {
  if (appKeyReady(env)) return;
  throw new ApiError(409, 'CONFLICT', 'Add APP_ENCRYPTION_KEY to your host first: webhook signing secrets are stored encrypted with it.', {
    reason: 'encryption_key_missing',
    hint: 'Settings > Workspace > Encryption says how to add it. Endpoints you already have keep working.',
  });
}

/** The stored form of a secret: sealed when the app key is set, else as given (an existing plain-text secret). */
export function sealWebhookSecret(endpointId: string, secret: string, env: Env = process.env): string {
  return appKeyReady(env) ? seal('webhooks', secret, endpointId, env) : secret;
}

/** The secret to sign with. Throws when it is sealed and the app key is missing or changed. */
export function openWebhookSecret(endpointId: string, stored: string, env: Env = process.env): string {
  return isAppSealed(stored) ? open('webhooks', stored, endpointId, env) : stored;
}

/** Whether a stored secret is sealed with the app key. */
export const isSealedWebhookSecret = (stored: string | null | undefined): boolean => isAppSealed(stored);

/**
 * Seals a plaintext secret in place, when the host has the app key. A
 * compare-and-swap: the row changes only while it still holds exactly the
 * plaintext that was loaded, so concurrent deliveries seal it once and a
 * secret rotated meanwhile is left alone. The sealed value opens back to the
 * same plaintext (checked before writing), so signatures stay byte-identical.
 * True when this call sealed it; false when there was nothing to do or
 * another writer got there first.
 */
export async function sealStoredWebhookSecret(
  service: SupabaseClient,
  endpointId: string,
  stored: string | null | undefined,
  env: Env = process.env,
): Promise<boolean> {
  if (!stored || isAppSealed(stored) || !appKeyReady(env)) return false;
  const sealed = seal('webhooks', stored, endpointId, env);
  if (open('webhooks', sealed, endpointId, env) !== stored) return false;
  const { data, error } = await service.from('webhook_endpoints').update({ secret: sealed })
    .eq('id', endpointId).eq('secret', stored).select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
